#!/usr/bin/env node
// Build release assets locally. This command never uploads or publishes them.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const agentRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(agentRoot, "../..");
const ownerFile = ".opsgrid-release-build";
const ownerValue = "opsgrid-agent-release-v1\n";
const beginMarker = "# OPSGRID_BUNDLE_BEGIN";
const endMarker = "# OPSGRID_BUNDLE_END";
const definitions = {
  linux: {
    installer: "install.sh",
    launcher: "install-launcher.sh",
    modules: ["runtime", "preflight", "filesystem", "repositories", "alloy", "enrollment", "configuration", "transaction", "reconciliation", "telegraf"].map((name) => `lib/linux/${name}.sh`),
    templates: ["linux.config.alloy.template"],
  },
  windows: {
    installer: "install.ps1",
    launcher: "install-launcher.ps1",
    modules: ["Runtime", "Preflight", "Security", "Alloy", "Enrollment", "Configuration", "Transaction", "Profiles", "Telegraf"].map((name) => `lib/windows/${name}.ps1`),
    templates: ["windows.config.alloy.template", "windows-baseline-v1.config.alloy.template"],
  },
};

const hash = (value) => createHash("sha256").update(value).digest("hex");
const normalize = (value) => value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

async function source(relativePath) {
  const value = normalize(await readFile(path.join(agentRoot, relativePath), "utf8"));
  return value.endsWith("\n") ? value : `${value}\n`;
}

async function bundle(platform, definition) {
  const wrapper = await source(definition.installer);
  const lines = wrapper.split("\n");
  const starts = lines.flatMap((line, index) => line === beginMarker ? [index] : []);
  const ends = lines.flatMap((line, index) => line === endMarker ? [index] : []);
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
    throw new Error(`${definition.installer}: expected exactly one ordered bundle region`);
  }
  const expectedImports = definition.modules.map((module) => platform === "linux"
    ? `source "\${OPSGRID_INSTALLER_ROOT}/${module}"`
    : `. (Join-Path $script:OpsGridInstallerRoot '${module}')`);
  const imports = lines.slice(starts[0] + 1, ends[0]).filter((line) => line.trim() !== "");
  if (JSON.stringify(imports) !== JSON.stringify(expectedImports)) {
    throw new Error(`${definition.installer}: bundle imports must match the fixed module allowlist and order`);
  }
  const modules = await Promise.all(definition.modules.map(async (module) => ({ path: module, content: await source(module) })));
  const content = [
    lines.slice(0, starts[0]).join("\n"),
    ...modules.map((module) => `# Bundled from ${module.path}\n${module.content}`),
    lines.slice(ends[0] + 1).join("\n"),
  ].join("\n");
  return {
    content,
    sources: [
      { path: definition.installer, sha256: hash(wrapper) },
      ...modules.map((module) => ({ path: module.path, sha256: hash(module.content) })),
    ],
  };
}

async function requirePrivateRegularFile(filePath) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error("Release output files must be regular files with exactly one hard link");
  }
}

async function prepareOutput(outputDirectory, platforms, assetKeys) {
  const absolute = path.resolve(outputDirectory);
  await mkdir(absolute, { recursive: true });
  const resolved = await realpath(absolute);
  const relativeToSource = path.relative(agentRoot, resolved);
  if (resolved === projectRoot || relativeToSource === "" || (!relativeToSource.startsWith(`..${path.sep}`) && relativeToSource !== "..")) {
    throw new Error("Release output must not overwrite the project root or installer source tree");
  }
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new Error("Release output must not be a symbolic link");
  const entries = await readdir(absolute);
  if (entries.length > 0 && !entries.includes(ownerFile)) {
    throw new Error("Refusing to overwrite an existing directory not owned by the release builder");
  }
  // Validate every existing destination before writing anything. Hard links can
  // otherwise overwrite a source/outside inode even without symbolic links.
  const assetNames = platforms.flatMap((platform) => {
    const definition = definitions[platform];
    return [definition.installer, definition.launcher, ...definition.templates];
  });
  const allowedEntries = new Set([ownerFile, "alloy", "SHA256SUMS", "release-manifest.json", ...assetNames, ...assetKeys]);
  for (const entry of entries) {
    if (!allowedEntries.has(entry)) throw new Error(`Release output contains an unexpected entry: ${entry}`);
    const entryPath = path.join(absolute, entry);
    if (entry === "alloy") {
      const directoryInfo = await lstat(entryPath);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("Release template output must be a real directory");
      const allowedTemplates = new Set(platforms.flatMap((platform) => definitions[platform].templates));
      for (const template of await readdir(entryPath)) {
        if (!allowedTemplates.has(template)) throw new Error(`Release template output contains an unexpected entry: ${template}`);
        await requirePrivateRegularFile(path.join(entryPath, template));
      }
    } else await requirePrivateRegularFile(entryPath);
  }
  if (entries.length > 0 && await readFile(path.join(absolute, ownerFile), "utf8") !== ownerValue) {
    throw new Error("Refusing to overwrite an existing directory not owned by the release builder");
  }
  if (entries.includes("release-manifest.json")) {
    let previous;
    try { previous = JSON.parse(await readFile(path.join(absolute, "release-manifest.json"), "utf8")); }
    catch { throw new Error("Existing release manifest is invalid"); }
    if (!Array.isArray(previous.platforms) || previous.platforms.some((platform) => !platforms.includes(platform))) {
      throw new Error("Cannot downgrade an existing synchronized output to a partial platform build");
    }
  }
  return absolute;
}

const nativeBuildID = "opsgrid-custom-6ab4b57bbaede19d";
const nativeInputs = {
  linux: { directory: ".superpowers/telegraf-build/task-6-artifacts/linux-amd64-XW7aYW", binary: "opsgrid-agent", asset: "opsgrid-agent-linux-amd64", sha256: "6f96523b7d44bb1283bbe5af3bc5a6241c013868a80cd4191549c51588966e56" },
  windows: { directory: ".superpowers/telegraf-build/task-6-artifacts/windows-amd64-Lyq8qK", binary: "opsgrid-agent.exe", asset: "opsgrid-agent-windows-amd64.exe", sha256: "f9136038fccb20680e99e6fc3cd804ed18ec63d97a7bc28ab384595a23596a9c" },
};

async function collectNative(platform, assets, sources) {
  const input = nativeInputs[platform];
  const directory = path.join(projectRoot, input.directory);
  const receipt = JSON.parse(await readFile(path.join(directory, "build-identity.json"), "utf8"));
  const binary = await readFile(path.join(directory, input.binary));
  const lock = JSON.parse(await source("telegraf/upstream.lock.json"));
  if (receipt.buildID !== nativeBuildID || receipt.mode !== "custom" || !receipt.customLifecycleImplemented ||
      receipt.target !== `${platform}-amd64` || receipt.binary !== input.binary ||
      receipt.binarySha256 !== input.sha256 || hash(binary) !== input.sha256 ||
      receipt.upstreamCommit !== lock.commit || receipt.sourceArchiveSha256 !== lock.archive.sha256) {
    throw new Error(`Unapproved native artifact or provenance: ${platform}`);
  }
  const overlayNames = (await readdir(path.join(agentRoot, "telegraf/opsgrid"))).sort();
  if (JSON.stringify(overlayNames) !== JSON.stringify(Object.keys(receipt.overlaySha256).sort()) ||
      hash(JSON.stringify({ overlaySha256: receipt.overlaySha256, patchSha256: receipt.patchSha256 })) !== receipt.overlayHash ||
      receipt.overlayHash.slice(0, 16) !== nativeBuildID.slice("opsgrid-custom-".length)) {
    throw new Error("Native overlay inventory or build identity changed");
  }
  // Preserve the pinned upstream dependency notices, not just the Telegraf MIT license.
  // Read only this member from the already hash-verified archive; no extraction or rebuild.
  if (!assets.has("LICENSE_OF_DEPENDENCIES.telegraf.md")) {
    const archive = path.join(projectRoot, ".superpowers/telegraf-build/cache", `telegraf-${lock.commit}.tar.gz`);
    if (hash(await readFile(archive)) !== lock.archive.sha256) throw new Error("Upstream license archive hash mismatch");
    const { stdout } = await promisify(execFile)("tar", ["-xOf", archive, `telegraf-${lock.commit}/docs/LICENSE_OF_DEPENDENCIES.md`], { encoding: "buffer", maxBuffer: 1024 * 1024 });
    if (stdout.length === 0) throw new Error("Upstream dependency notices missing");
    assets.set("LICENSE_OF_DEPENDENCIES.telegraf.md", stdout);
  }
  const current = {
    "telegraf/upstream.lock.json": receipt.lockSha256,
    "telegraf/build.mjs": receipt.builderSha256,
    "telegraf/metrics-contract.json": receipt.contractSha256,
    "telegraf/patches/opsgrid-lifecycle.patch": receipt.patchSha256,
    ...Object.fromEntries(Object.entries(receipt.overlaySha256).map(([name, digest]) => [`telegraf/opsgrid/${name}`, digest])),
  };
  for (const [name, digest] of Object.entries(current)) {
    const bytes = await readFile(path.join(agentRoot, name));
    if (hash(bytes) !== digest) throw new Error(`Native source changed; rebuild and review required: ${name}`);
    sources.push({ path: name, sha256: digest });
  }
  assets.set(input.asset, binary);
  for (const [name, asset] of [["build-identity.json", `${platform}-amd64.build-identity.json`], ["LICENSE.telegraf", `${platform}-amd64.LICENSE.telegraf`], ["metrics-contract.json", `${platform}-amd64.metrics-contract.json`]]) {
    const bytes = await readFile(path.join(directory, name));
    if (name === "metrics-contract.json" && hash(bytes) !== receipt.contractSha256) throw new Error("Native metrics contract drift");
    assets.set(asset, bytes);
  }
  return { target: receipt.target, binary: input.asset, sha256: input.sha256, buildIdentity: `${platform}-amd64.build-identity.json`, license: `${platform}-amd64.LICENSE.telegraf`, dependenciesLicense: "LICENSE_OF_DEPENDENCIES.telegraf.md", metricsContract: `${platform}-amd64.metrics-contract.json`, provenance: receipt };
}

async function collectAssets(platforms, collector = "alloy") {
  if (!["alloy", "telegraf"].includes(collector)) throw new Error("Select collector alloy or telegraf");
  if (platforms.length === 0 || platforms.some((platform) => !Object.hasOwn(definitions, platform)) || new Set(platforms).size !== platforms.length) {
    throw new Error("Select linux, windows, or both platforms exactly once");
  }
  platforms = ["linux", "windows"].filter((platform) => platforms.includes(platform));
  // Read and validate every source before creating or updating output artifacts.
  const assets = new Map();
  const native = [];
  const selectCollector = (text) => text.replace("OPSGRID_RELEASE_COLLECTOR='telegraf'", `OPSGRID_RELEASE_COLLECTOR='${collector}'`).replace("$script:OpsGridReleaseCollector = 'telegraf'", `$script:OpsGridReleaseCollector = '${collector}'`);
  const sources = [{ path: "build-release.mjs", sha256: hash(await source("build-release.mjs")) }];
  for (const platform of platforms) {
    const definition = definitions[platform];
    const installer = await bundle(platform, definition);
    assets.set(definition.installer, selectCollector(installer.content));
    sources.push(...installer.sources);
    const launcher = await source(definition.launcher);
    assets.set(definition.launcher, selectCollector(launcher));
    if (collector === "telegraf") native.push(await collectNative(platform, assets, sources));
    sources.push({ path: definition.launcher, sha256: hash(launcher) });
    for (const template of definition.templates) {
      const content = await source(`alloy/${template}`);
      assets.set(template, content);
      sources.push({ path: `alloy/${template}`, sha256: hash(content) });
    }
  }
  return { platforms, assets, sources, collector, native };
}

function releaseManifest({ platforms, assets, sources, collector, native }) {
  return {
    schemaVersion: 1,
    collector,
    ...(collector === "telegraf" ? { buildID: nativeBuildID, native, runtimeVerification: "unverified" } : {}),
    platforms,
    synchronized: platforms.length === 2,
    sourceDigest: hash(JSON.stringify(sources)),
    sources,
    assets: [...assets].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([name, content]) => ({ name, sha256: hash(content), bytes: Buffer.byteLength(content, "utf8") })),
    // Hashes detect drift; an unsigned manifest is not a publisher attestation.
  };
}

const checksums = (manifest) => manifest.assets.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n") + "\n";
const defaultOutput = path.join(projectRoot, ".superpowers/agent-refactor/release");

export async function verifyRelease({ outputDirectory = defaultOutput, platforms = ["linux", "windows"], collector = "alloy" } = {}) {
  const collected = await collectAssets(platforms, collector);
  const expected = releaseManifest(collected);
  const output = path.resolve(outputDirectory);
  if ((await lstat(output)).isSymbolicLink()) throw new Error("Release output must not be a symbolic link");
  const expectedEntries = [ownerFile, "alloy", "SHA256SUMS", "release-manifest.json", ...collected.assets.keys()].sort();
  if (JSON.stringify((await readdir(output)).sort()) !== JSON.stringify(expectedEntries)) {
    throw new Error("Release output contains missing or unexpected entries");
  }
  for (const entry of expectedEntries) {
    const entryPath = path.join(output, entry);
    if (entry === "alloy") {
      const info = await lstat(entryPath);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Release template output must be a real directory");
    } else await requirePrivateRegularFile(entryPath);
  }
  const templates = [...collected.assets.keys()].filter((name) => name.endsWith(".alloy.template"));
  if (JSON.stringify((await readdir(path.join(output, "alloy"))).sort()) !== JSON.stringify([...templates].sort())) {
    throw new Error("Release template output contains missing or unexpected entries");
  }
  for (const [name, content] of collected.assets) {
    if (!(await readFile(path.join(output, name))).equals(Buffer.from(content, "utf8"))) throw new Error(`Release asset drift: ${name}`);
    if (templates.includes(name)) {
      const templatePath = path.join(output, "alloy", name);
      await requirePrivateRegularFile(templatePath);
      if (!(await readFile(templatePath)).equals(Buffer.from(content, "utf8"))) throw new Error(`Release template drift: ${name}`);
    }
  }
  if (await readFile(path.join(output, ownerFile), "utf8") !== ownerValue ||
      await readFile(path.join(output, "SHA256SUMS"), "utf8") !== checksums(expected) ||
      await readFile(path.join(output, "release-manifest.json"), "utf8") !== JSON.stringify(expected, null, 2) + "\n") {
    throw new Error("Release manifest, source provenance or checksums do not match current sources");
  }
  return { outputDirectory: output, manifest: expected };
}

export async function buildRelease({ outputDirectory = defaultOutput, platforms = ["linux", "windows"], collector = "alloy" } = {}) {
  const collected = await collectAssets(platforms, collector);
  const { assets } = collected;
  const manifest = releaseManifest(collected);
  const output = await prepareOutput(outputDirectory, collected.platforms, [...assets.keys()]);
  const templateDirectory = path.join(output, "alloy");
  await mkdir(templateDirectory, { recursive: true });
  for (const entry of await readdir(templateDirectory)) {
    if ((await lstat(path.join(templateDirectory, entry))).isSymbolicLink()) {
      throw new Error("Release template output contains a symbolic link");
    }
  }
  await writeFile(path.join(output, ownerFile), ownerValue, "utf8");
  for (const [name, content] of assets) {
    await writeFile(path.join(output, name), content, { encoding: "utf8", mode: name.endsWith(".sh") ? 0o755 : 0o644 });
    if (name.endsWith(".alloy.template")) await writeFile(path.join(templateDirectory, name), content, "utf8");
  }
  await writeFile(path.join(output, "SHA256SUMS"), checksums(manifest), "utf8");
  // Write the completion manifest last. Publishing is a separate human-approved step.
  await writeFile(path.join(output, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return verifyRelease({ outputDirectory: output, platforms: collected.platforms, collector });
}

async function main(arguments_) {
  let outputDirectory;
  let verify = false;
  let collector = "alloy";
  let platforms = ["linux", "windows"];
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--verify") verify = true;
    else if (argument === "--collector" && ["alloy", "telegraf"].includes(arguments_[index + 1])) collector = arguments_[++index];
    else if (argument === "--output" && arguments_[index + 1]) outputDirectory = arguments_[++index];
    else if (argument === "--platform" && ["linux", "windows", "all"].includes(arguments_[index + 1])) {
      const platform = arguments_[++index];
      platforms = platform === "all" ? ["linux", "windows"] : [platform];
    } else if (argument === "--help") {
      console.log("Usage: node deploy/agent/build-release.mjs [--verify] [--collector alloy|telegraf] [--platform linux|windows|all] [--output DIRECTORY]");
      return;
    } else throw new Error("Invalid release build arguments");
  }
  const result = await (verify ? verifyRelease : buildRelease)({ outputDirectory, platforms, collector });
  console.log(`[opsgrid-agent] ${verify ? "Verified" : "Built"} ${result.manifest.assets.length} ${result.manifest.synchronized ? "synchronized" : platforms[0]} release assets in ${result.outputDirectory}; not published.`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[opsgrid-agent] Release build failed: ${error.message}`);
    process.exitCode = 1;
  });
}
