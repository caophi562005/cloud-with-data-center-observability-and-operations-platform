#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, "../../..");
const ownerName = ".opsgrid-telegraf-build";
const ownerValue = "opsgrid-telegraf-build-v1";
const prefix = "[opsgrid-agent]";
const log = (text) => console.log(`${prefix} ${text}`);

async function exists(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function ownedDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe directory: ${directory}`);
  const marker = path.join(directory, ownerName);
  const markerStat = await exists(marker);
  if (markerStat) {
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || (await readFile(marker, "utf8")) !== ownerValue)
      throw new Error(`Invalid ownership marker: ${directory}`);
  } else {
    if ((await readdir(directory)).length) throw new Error(`Refusing non-empty unowned directory: ${directory}`);
    await writeFile(marker, ownerValue, { flag: "wx" });
  }
}

async function plainDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe directory: ${directory}`);
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function run(command, args, cwd, env = {}) {
  log(`${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status})`);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--upstream-only") options.upstreamOnly = true;
    else if (flag === "--compile-opsgrid") options.compileOpsgrid = true;
    else if (flag === "--custom") options.custom = true;
    else if (flag === "--help") options.help = true;
    else if (["--target", "--out", "--cache-dir"].includes(flag)) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Missing value for ${flag}`);
      options[flag.slice(2)] = argv[++i];
    } else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

// Overlay production sources and thin lifecycle patch onto a fresh, checksum-
// verified immutable archive. Never modifies or builds a maintained vendor tree.
export function overlayPaths(lock, source) {
  return {
    moduleSource: path.join(here, lock.overlay.sourceDirectory),
    moduleDestination: path.join(source, lock.overlay.destinationDirectory),
    lifecyclePatch: path.join(here, lock.overlay.lifecyclePatch),
  };
}

export async function build(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    log("Usage: node deploy/agent/telegraf/build.mjs [--custom|--upstream-only|--compile-opsgrid] --target <linux-amd64|linux-arm64|windows-amd64> --out <owned-directory> [--cache-dir <owned-directory>]");
    return;
  }
  if ([options.upstreamOnly, options.compileOpsgrid, options.custom].filter(Boolean).length > 1) throw new Error("Choose one build mode");
  const lock = JSON.parse(await readFile(path.join(here, "upstream.lock.json"), "utf8"));
  if (!lock.targets.includes(options.target)) throw new Error("Provide one supported --target");
  if (!options.out) throw new Error("Provide --out");
  if (!/^[a-f0-9]{40}$/.test(lock.commit) || !/^[a-f0-9]{64}$/.test(lock.archive.sha256))
    throw new Error("Invalid immutable source lock");
  if (lock.archive.url !== `https://codeload.github.com/influxdata/telegraf/tar.gz/${lock.commit}` ||
      lock.archive.root !== `telegraf-${lock.commit}`) throw new Error("Archive does not match locked source");

  const root = path.resolve(options["cache-dir"] ?? path.join(workspace, ".superpowers", "telegraf-build"));
  const out = path.resolve(options.out);
  await ownedDirectory(root);
  await ownedDirectory(out);
  const cache = path.join(root, "cache");
  await plainDirectory(cache);
  const archive = path.join(cache, `telegraf-${lock.commit}.tar.gz`);
  const archiveStat = await exists(archive);
  if (archiveStat && (!archiveStat.isFile() || archiveStat.isSymbolicLink())) throw new Error("Unsafe cached archive");
  if (!archiveStat) {
    log(`Downloading immutable source ${lock.commit}`);
    const response = await fetch(lock.archive.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`Source download failed: HTTP ${response.status}`);
    // Exclusive creation: never overwrite a cache entry, including a partial one.
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: "wx" }));
  }
  const archiveHash = await digest(archive);
  if (archiveHash !== lock.archive.sha256)
    throw new Error(`Cached source checksum mismatch: expected ${lock.archive.sha256}, got ${archiveHash}; leave it intact and choose a fresh --cache-dir`);
  log(`Verified source SHA256 ${archiveHash}`);

  const staging = await mkdtemp(path.join(root, "stage-"));
  const source = path.join(staging, "source");
  await mkdir(source);
  run("tar", ["-xzf", archive, "--strip-components=1", "-C", source], staging);
  const goMod = await readFile(path.join(source, "go.mod"), "utf8");
  if (!new RegExp(`^go ${lock.go.minimum.replaceAll(".", "\\.")}$`, "m").test(goMod))
    throw new Error("Upstream Go requirement differs from lock");
  const [goos, goarch] = options.target.split("-");
  const overlaySha256 = {};
  let patchSha256 = null;
  if (!options.upstreamOnly) {
    const overlay = overlayPaths(lock, source);
    const moduleStat = await lstat(overlay.moduleSource);
    if (!moduleStat.isDirectory() || moduleStat.isSymbolicLink()) throw new Error("Unsafe local module source");
    if (await exists(overlay.moduleDestination)) throw new Error("Upstream unexpectedly contains overlay destination");
    await mkdir(overlay.moduleDestination);
    const files = ["types.go", "client.go", "identity.go", "store.go", "store_linux.go", "store_windows.go", "coordinator.go", "policy.go", "binding.go"];
    if (JSON.stringify([...lock.overlay.files].sort()) !== JSON.stringify([...files].sort())) throw new Error("Overlay file list differs from lock");
    for (const name of files) {
      const local = path.join(overlay.moduleSource, name);
      const stat = await lstat(local);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe overlay file: ${name}`);
      const bytes = await readFile(local);
      overlaySha256[name] = createHash("sha256").update(bytes).digest("hex");
      await writeFile(path.join(overlay.moduleDestination, name), bytes, { flag: "wx" });
    }
    const patchStat = await lstat(overlay.lifecyclePatch);
    if (!patchStat.isFile() || patchStat.isSymbolicLink()) throw new Error("Unsafe lifecycle patch");
    const patchBytes = await readFile(overlay.lifecyclePatch);
    patchSha256 = createHash("sha256").update(patchBytes).digest("hex");
    if (patchSha256 !== lock.overlay.patchSha256) throw new Error("Lifecycle patch checksum differs from lock");
    const stagedPatch = path.join(staging, "opsgrid-lifecycle.patch");
    await writeFile(stagedPatch, patchBytes, { flag: "wx" });
    // git apply needs no repository/index. --check rejects mismatched upstream
    // context; only these six native lifecycle/CLI files may be patched.
    const patchedFiles = [...patchBytes.toString("utf8").matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]).sort();
    const allowed = ["agent/agent.go", "cmd/telegraf/main.go", "cmd/telegraf/telegraf.go", "cmd/telegraf/telegraf_posix.go", "cmd/telegraf/telegraf_windows.go", "cmd/telegraf/cmd_win_service.go"].sort();
    if (JSON.stringify(patchedFiles) !== JSON.stringify(allowed)) throw new Error("Lifecycle patch scope differs");
    run("git", ["apply", "--check", stagedPatch], source);
    run("git", ["apply", stagedPatch], source);
  }
  if (options.compileOpsgrid) {
    const command = ["build", "-mod=readonly", "-trimpath", "-buildvcs=false", "./internal/opsgrid"];
    run("go", ["version"], source);
    run("go", command, source, { GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" });
    const receiptDirectory = await mkdtemp(path.join(out, `${options.target}-`));
    const receipt = {
      schemaVersion: 1, mode: "opsgrid-package-compile", customLifecycleImplemented: true, patchSha256,
      target: options.target, upstreamVersion: lock.version, upstreamCommit: lock.commit,
      sourceArchiveSha256: archiveHash, overlaySha256, command: ["go", ...command], exitCode: 0,
      lockSha256: await digest(path.join(here, "upstream.lock.json")),
      builderSha256: await digest(fileURLToPath(import.meta.url)), staging,
      builtAt: new Date().toISOString(), runtimeVerification: "unverified", binaryProduced: false,
    };
    await writeFile(path.join(receiptDirectory, "package-compile.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    log(`Compiled lifecycle package; receipt ${path.join(receiptDirectory, "package-compile.json")}`);
    return receipt;
  }
  const tags = ["custom", ...Object.entries(lock.plugins).flatMap(([category, plugins]) => {
    if (category === "windowsInputs") return goos === "windows" ? plugins.map((plugin) => `inputs.${plugin}`) : [];
    return plugins.map((plugin) => `${category}.${plugin}`);
  })];
  const artifactDirectory = await mkdtemp(path.join(out, `${options.target}-`));
  const binary = path.join(artifactDirectory, goos === "windows" ? "opsgrid-agent.exe" : "opsgrid-agent");
  const overlayHash = createHash("sha256").update(JSON.stringify({ overlaySha256, patchSha256 })).digest("hex");
  const buildID = options.upstreamOnly ? "opsgrid-upstream-only" : `opsgrid-custom-${overlayHash.slice(0, 16)}`;
  const ldflags = ["-s", "-w", `-X github.com/influxdata/telegraf/internal.Version=${lock.version}-${buildID}`,
    `-X github.com/influxdata/telegraf/internal.Commit=${lock.commit}`, `-X github.com/influxdata/telegraf/internal.Branch=${buildID}`].join(" ");
  run("go", ["version"], source);
  run("go", ["build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-tags", tags.join(","), "-ldflags", ldflags,
    "-o", binary, "./cmd/telegraf"], source, { GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" });
  run("go", ["version", "-m", binary], source);
  await writeFile(path.join(artifactDirectory, "LICENSE.telegraf"), await readFile(path.join(source, "LICENSE")), { flag: "wx" });
  await writeFile(path.join(artifactDirectory, "metrics-contract.json"), await readFile(path.join(here, "metrics-contract.json")), { flag: "wx" });
  const identity = {
    schemaVersion: 1, mode: options.upstreamOnly ? "upstream-only" : "custom", customLifecycleImplemented: !options.upstreamOnly,
    buildID, overlaySha256, patchSha256, overlayHash,
    target: options.target, upstreamVersion: lock.version, upstreamCommit: lock.commit,
    sourceArchiveSha256: archiveHash, binary: path.basename(binary), binarySha256: await digest(binary),
    lockSha256: await digest(path.join(here, "upstream.lock.json")),
    builderSha256: await digest(fileURLToPath(import.meta.url)),
    contractSha256: await digest(path.join(here, "metrics-contract.json")),
    goMinimum: lock.go.minimum, buildTags: tags, cgoEnabled: false, ldflags,
    builtAt: new Date().toISOString(), provenance: lock.provenance, license: lock.license,
    toolchainIdentity: "Embedded Go build info; inspect with go version -m <binary>",
    runtimeVerification: "unverified", staging,
  };
  await writeFile(path.join(artifactDirectory, "build-identity.json"), `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx" });
  log(`Built ${binary}`);
  return identity;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build().catch((error) => { console.error(`${prefix} ${error.message}`); process.exitCode = 1; });
}
