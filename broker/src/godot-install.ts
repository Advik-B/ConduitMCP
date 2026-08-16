// Godot editor installation (docs/environment.md, CONDUIT_AUTO_INSTALL_GODOT).
//
// godot-locate.ts finds an engine the machine already has. This installs one it
// does not. Without it the failure mode is a dead end: gd_editor_launch reports
// godot_binary_not_found with a list of places it looked, and no tool the agent
// can reach changes that answer.
//
// Structured to mirror addon.ts, because it is the same shape of operation with
// a different asset: resolve a source, verify it, stage, swap atomically. Three
// things differ and each is a deliberate divergence rather than drift. The
// engine has no version marker file, since the install directory is named for
// the version and nothing but this module writes there. Godot publishes SHA512,
// not SHA256, under a differently spelled filename. And the archives are the
// engine's own, so they carry Unix modes that must survive extraction: a binary
// without its executable bit will not launch, and the macOS bundle uses
// symlinks.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { engineDir, findEngineBinary } from "./godot-locate.ts";
import { isSafeEntryName, isSymlink, iterZip } from "./zip.ts";

export { engineDir };

const RELEASES = "https://github.com/godotengine/godot/releases";
const CHECKSUMS = "SHA512-SUMS.txt";
// Written last, so an install killed partway reads back as unmanaged and
// prompts a reinstall rather than being mistaken for a good one. Same trick and
// same reason as addon.ts's .conduit-version.
const VERSION_MARKER = ".conduit-engine";

export type EngineState =
  /** No engine of this build in the install directory. */
  | "missing"
  /** Installed by this broker, marker present. */
  | "current"
  /** A binary is there without a marker: somebody else's. Never overwritten silently. */
  | "unmanaged";

export interface EngineDetection {
  state: EngineState;
  tag: string;
  mono: boolean;
  dir: string;
  binary: string | null;
}

export interface EngineInstallOptions {
  /** Release tag such as "4.7.1-stable". Omitted means resolve the latest. */
  version?: string | null;
  /** Install the .NET/C# build instead of the standard one. */
  mono?: boolean;
  /** Root holding one directory per installed build. */
  engineDir: string;
  /** CONDUIT_ENGINE_SOURCE: a local zip, an unpacked directory, or a URL. */
  source?: string | null;
  /** Replace an install already in that directory, managed or not. */
  force?: boolean;
}

export interface EngineInstallResult {
  installed: boolean;
  version: string;
  mono: boolean;
  binary: string;
  dir: string;
  source: string;
  files: number;
}

export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/**
 * The release asset base name for a platform, without the trailing .zip.
 *
 * Godot publishes one editor archive per platform and architecture. macOS is a
 * single universal build, so the architecture does not enter into it there.
 */
export function engineAssetName(
  tag: string,
  mono = false,
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  // The .NET assets are not the standard names with an infix: Linux swaps the
  // dot before the architecture for an underscore, and Windows drops the .exe
  // that the standard archive carries. Spelled out per case rather than
  // derived, because deriving them gets it wrong.
  if (platform === "darwin") {
    return mono ? `Godot_v${tag}_mono_macos.universal` : `Godot_v${tag}_macos.universal`;
  }
  if (platform === "linux") {
    if (arch === "x64") {
      return mono ? `Godot_v${tag}_mono_linux_x86_64` : `Godot_v${tag}_linux.x86_64`;
    }
    if (arch === "arm64") {
      return mono ? `Godot_v${tag}_mono_linux_arm64` : `Godot_v${tag}_linux.arm64`;
    }
  }
  if (platform === "win32") {
    if (arch === "x64") {
      return mono ? `Godot_v${tag}_mono_win64` : `Godot_v${tag}_win64.exe`;
    }
    if (arch === "arm64") {
      return mono ? `Godot_v${tag}_mono_windows_arm64` : `Godot_v${tag}_windows_arm64.exe`;
    }
  }
  throw new EngineError(
    "engine_platform_unsupported",
    `no Godot ${mono ? ".NET " : ""}editor archive is published for ${platform}/${arch}; install Godot yourself and pass --godot`,
  );
}

function assetUrl(tag: string, asset: string): string {
  return `${RELEASES}/download/${tag}/${asset}.zip`;
}

function checksumsUrl(tag: string): string {
  return `${RELEASES}/download/${tag}/${CHECKSUMS}`;
}

async function fetchBytes(url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new EngineError("engine_download_failed", `could not reach ${url}: ${String(error)}`, true);
  }
  if (!response.ok) {
    throw new EngineError("engine_download_failed", `${url} returned HTTP ${response.status}`, response.status >= 500);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * The newest release tag, read from the redirect the releases/latest URL issues.
 * Cheaper and less rate-limited than the API, and it is the same trick
 * scripts/setup.ts uses.
 */
export async function resolveLatestTag(): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${RELEASES}/latest`, { redirect: "manual" });
  } catch (error) {
    throw new EngineError("engine_download_failed", `could not reach ${RELEASES}/latest: ${String(error)}`, true);
  }
  const location = response.headers.get("location");
  const tag = location?.split("/").pop();
  if (!tag) {
    throw new EngineError("engine_version_unresolved", "could not resolve the latest Godot release from the redirect", true);
  }
  return tag;
}

/**
 * Parse a SHA512-SUMS.txt body for one asset's digest. Exported for tests: the
 * format is the only part of the verification that can silently stop matching.
 */
export function digestFor(sums: string, assetName: string): string | null {
  return (
    sums
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find((parts) => {
        const listed = parts[1];
        if (!listed) {
          return false;
        }
        // The binary-mode marker is part of the name field, not the name, and
        // Godot lists some assets with a path in front of them. Compare the
        // basename or a perfectly good release reads as unlisted.
        return path.posix.basename(listed.replace(/^\*/, "").replace(/\\/g, "/")) === assetName;
      })?.[0] ?? null
  );
}

/**
 * Verify a downloaded archive against the SHA512-SUMS.txt published beside it.
 * A mismatch is a corrupted or substituted asset, so the install fails closed
 * rather than unpacking and running it.
 */
async function verifyChecksum(zip: Buffer, tag: string, assetName: string): Promise<void> {
  const sums = (await fetchBytes(checksumsUrl(tag))).toString("utf8");
  const expected = digestFor(sums, `${assetName}.zip`);
  if (!expected) {
    throw new EngineError("engine_checksum_missing", `${assetName}.zip is not listed in ${CHECKSUMS} for ${tag}`);
  }
  const actual = createHash("sha512").update(zip).digest("hex");
  if (actual !== expected) {
    throw new EngineError(
      "engine_checksum_mismatch",
      `${assetName}.zip hashed to ${actual.slice(0, 16)}... but ${CHECKSUMS} lists ${expected.slice(0, 16)}...; refusing to install`,
    );
  }
}

interface StagedFile {
  relative: string;
  data: Buffer;
  mode: number;
}

// A generator, not an array: the caller writes each entry and lets it go, so a
// ~100 MB archive never has its whole decompressed tree resident at once.
function* stageFromZip(zip: Buffer): Generator<StagedFile> {
  let any = false;
  for (const entry of iterZip(zip)) {
    if (!isSafeEntryName(entry.name)) {
      throw new EngineError("engine_unsafe_archive", `archive entry ${entry.name} is not a safe relative path`);
    }
    any = true;
    yield { relative: entry.name, data: entry.data, mode: entry.mode };
  }
  if (!any) {
    throw new EngineError("engine_source_invalid", "archive contains no files");
  }
}

function stageFromDirectory(dir: string): StagedFile[] {
  const staged: StagedFile[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, relative);
      } else if (entry.isFile()) {
        staged.push({ relative, data: fs.readFileSync(full), mode: fs.statSync(full).mode & 0o7777 });
      }
    }
  };
  walk(dir, "");
  if (staged.length === 0) {
    throw new EngineError("engine_source_invalid", `${dir} contains no files`);
  }
  return staged;
}

async function resolveSource(
  tag: string,
  options: EngineInstallOptions,
): Promise<{ files: Iterable<StagedFile>; description: string }> {
  const source = options.source ?? null;
  if (source && !/^https?:\/\//.test(source)) {
    const stat = fs.existsSync(source) ? fs.statSync(source) : null;
    if (!stat) {
      throw new EngineError("engine_source_invalid", `CONDUIT_ENGINE_SOURCE ${source} does not exist`);
    }
    if (stat.isDirectory()) {
      return { files: stageFromDirectory(source), description: source };
    }
    return { files: stageFromZip(fs.readFileSync(source)), description: source };
  }

  const asset = engineAssetName(tag, options.mono === true);
  const url = source ?? assetUrl(tag, asset);
  const zip = await fetchBytes(url);
  // Only the canonical release asset can be checked: an explicit URL is the
  // caller vouching for their own source.
  if (!source) {
    await verifyChecksum(zip, tag, asset);
  }
  return { files: stageFromZip(zip), description: url };
}

/**
 * Where a given build lives under the install root. The .NET build gets its own
 * directory so both can be installed at the same version without one replacing
 * the other.
 */
export function versionDir(engineDir: string, tag: string, mono = false): string {
  return path.join(engineDir, mono ? `${tag}-mono` : tag);
}

export interface InstalledEngine {
  tag: string;
  mono: boolean;
  binary: string;
  /** False for an engine that appeared here without this broker installing it. */
  managed: boolean;
}

/**
 * Every engine build under the install root. Cheap filesystem walk, so it can
 * go in a status response without a flag guarding it.
 */
export function listInstalledEngines(root: string): InstalledEngine[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const found: InstalledEngine[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) {
      continue;
    }
    const dir = path.join(root, name);
    const binary = findEngineBinary(dir);
    if (!binary) {
      continue;
    }
    const mono = name.endsWith("-mono");
    found.push({
      tag: mono ? name.slice(0, -"-mono".length) : name,
      mono,
      binary,
      managed: fs.existsSync(path.join(dir, VERSION_MARKER)),
    });
  }
  return found;
}

/** Whether this build is already installed, who installed it, and the binary. */
export function detectEngine(engineDir: string, tag: string, mono = false): EngineDetection {
  const dir = versionDir(engineDir, tag, mono);
  const binary = findEngineBinary(dir);
  if (!binary) {
    return { state: "missing", tag, mono, dir, binary: null };
  }
  const managed = fs.existsSync(path.join(dir, VERSION_MARKER));
  return { state: managed ? "current" : "unmanaged", tag, mono, dir, binary };
}

/**
 * Write staged files, restoring the modes the archive carried.
 *
 * Every published Godot archive is written on a Unix host, so the modes are
 * real: the Linux editor arrives 0755 and the macOS bundle carries its
 * per-file bits. None of the four archives contains a symlink today, checked
 * against the 4.7.1 central directories, but the handling is here anyway
 * because an archive that gained one would otherwise unpack a text file where
 * a link belongs and fail much later.
 */
function writeStaged(target: string, files: Iterable<StagedFile>): number {
  let written = 0;
  for (const file of files) {
    const destination = path.join(target, file.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (isSymlink(file.mode) && process.platform !== "win32") {
      const link = file.data.toString("utf8");
      // A symlink target that escapes the install root would let an archive
      // write anywhere the broker can, so it gets the same check entry names get.
      if (path.isAbsolute(link) || !isSafeEntryName(path.posix.join(path.posix.dirname(file.relative), link))) {
        throw new EngineError("engine_unsafe_archive", `archive symlink ${file.relative} points outside the archive`);
      }
      fs.symlinkSync(link, destination);
    } else {
      fs.writeFileSync(destination, file.data);
      if (file.mode !== 0 && process.platform !== "win32") {
        fs.chmodSync(destination, file.mode & 0o7777);
      }
    }
    written++;
  }
  return written;
}

/**
 * Install a Godot editor into the engine directory. Never touches a Godot
 * project and never writes outside engineDir, so unlike installAddon it has no
 * reason to care whether an editor is connected.
 */
export async function installEngine(options: EngineInstallOptions): Promise<EngineInstallResult> {
  const tag = options.version || (await resolveLatestTag());
  const mono = options.mono === true;
  const detection = detectEngine(options.engineDir, tag, mono);
  if (detection.state === "current" && !options.force) {
    return {
      installed: false,
      version: tag,
      mono,
      binary: detection.binary ?? "",
      dir: detection.dir,
      source: detection.dir,
      files: 0,
    };
  }
  if (detection.state === "unmanaged" && !options.force) {
    throw new EngineError(
      "engine_already_installed",
      `${detection.dir} holds an engine this broker did not install (no ${VERSION_MARKER}); pass force=true to replace it`,
    );
  }

  const { files, description } = await resolveSource(tag, options);

  // Stage beside the destination, then swap, so an interrupted install leaves
  // the previous engine intact rather than a half-written one. Renaming over an
  // existing directory fails on Windows, so the old copy goes first.
  const staging = path.join(options.engineDir, `.${tag}${mono ? "-mono" : ""}-install-tmp`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  let count: number;
  let swapped = false;
  try {
    count = writeStaged(staging, files);
    fs.rmSync(detection.dir, { recursive: true, force: true });
    fs.renameSync(staging, detection.dir);
    swapped = true;
  } finally {
    if (!swapped) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  const binary = findEngineBinary(detection.dir);
  if (!binary) {
    throw new EngineError("engine_source_invalid", `${description} unpacked into ${detection.dir} with no Godot binary in it`);
  }
  // Belt and braces over the archive's own mode: a source that lost its
  // permission bits (a directory copied through a Windows share, a zip written
  // without Unix attributes) would otherwise install an engine that cannot run.
  if (process.platform !== "win32") {
    fs.chmodSync(binary, 0o755);
  }

  // Written last, after the binary is known good: an install that dies before
  // this reads back as unmanaged, which asks for a reinstall rather than being
  // trusted as current.
  fs.writeFileSync(path.join(detection.dir, VERSION_MARKER), `${tag}${mono ? " mono" : ""}\n`);

  return { installed: true, version: tag, mono, binary, dir: detection.dir, source: description, files: count };
}
