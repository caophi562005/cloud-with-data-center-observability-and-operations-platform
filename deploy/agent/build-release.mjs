#!/usr/bin/env node
// Build release assets locally. This command never uploads or publishes them.
import { createHash } from "node:crypto";
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
    modules: ["runtime", "preflight", "filesystem", "repositories", "alloy", "enrollment", "configuration", "transaction", "reconciliation"].map((name) => `lib/linux/${name}.sh`),
    templates: ["linux.config.alloy.template"],
  },
  windows: {
    installer: "install.ps1",
    launcher: "install-launcher.ps1",
    modules: ["Runtime", "Preflight", "Security", "Alloy", "Enrollment", "Configuration", "Transaction", "Profiles"].map((name) => `lib/windows/${name}.ps1`),
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

async function prepareOutput(outputDirectory, platforms) {
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
  const allowedEntries = new Set([ownerFile, "alloy", "SHA256SUMS", "release-manifest.json", ...assetNames]);
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

async function collectAssets(platforms) {
  if (platforms.length === 0 || platforms.some((platform) => !Object.hasOwn(definitions, platform)) || new Set(platforms).size !== platforms.length) {
    throw new Error("Select linux, windows, or both platforms exactly once");
  }
  platforms = ["linux", "windows"].filter((platform) => platforms.includes(platform));
  // Read and validate every source before creating or updating output artifacts.
  const assets = new Map();
  const sources = [{ path: "build-release.mjs", sha256: hash(await source("build-release.mjs")) }];
  for (const platform of platforms) {
    const definition = definitions[platform];
    const installer = await bundle(platform, definition);
    assets.set(definition.installer, installer.content);
    sources.push(...installer.sources);
    const launcher = await source(definition.launcher);
    assets.set(definition.launcher, launcher);
    sources.push({ path: definition.launcher, sha256: hash(launcher) });
    for (const template of definition.templates) {
      const content = await source(`alloy/${template}`);
      assets.set(template, content);
      sources.push({ path: `alloy/${template}`, sha256: hash(content) });
    }
  }
  return { platforms, assets, sources };
}

function releaseManifest({ platforms, assets, sources }) {
  return {
    schemaVersion: 1,
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

export async function verifyRelease({ outputDirectory = defaultOutput, platforms = ["linux", "windows"] } = {}) {
  const collected = await collectAssets(platforms);
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

export async function buildRelease({ outputDirectory = defaultOutput, platforms = ["linux", "windows"] } = {}) {
  const collected = await collectAssets(platforms);
  const { assets } = collected;
  const manifest = releaseManifest(collected);
  const output = await prepareOutput(outputDirectory, collected.platforms);
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
  return verifyRelease({ outputDirectory: output, platforms: collected.platforms });
}

async function main(arguments_) {
  let outputDirectory;
  let verify = false;
  let platforms = ["linux", "windows"];
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--verify") verify = true;
    else if (argument === "--output" && arguments_[index + 1]) outputDirectory = arguments_[++index];
    else if (argument === "--platform" && ["linux", "windows", "all"].includes(arguments_[index + 1])) {
      const platform = arguments_[++index];
      platforms = platform === "all" ? ["linux", "windows"] : [platform];
    } else if (argument === "--help") {
      console.log("Usage: node deploy/agent/build-release.mjs [--verify] [--platform linux|windows|all] [--output DIRECTORY]");
      return;
    } else throw new Error("Invalid release build arguments");
  }
  const result = await (verify ? verifyRelease : buildRelease)({ outputDirectory, platforms });
  console.log(`[opsgrid-agent] ${verify ? "Verified" : "Built"} ${result.manifest.assets.length} ${result.manifest.synchronized ? "synchronized" : platforms[0]} release assets in ${result.outputDirectory}; not published.`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[opsgrid-agent] Release build failed: ${error.message}`);
    process.exitCode = 1;
  });
}
