// Addon detection and installation (docs/environment.md, CONDUIT_AUTO_INSTALL).
//
// Conduit is two halves: this broker, and a GDExtension that must live in the
// Godot project. Until now installing that half was a manual download-and-
// extract, and the autoload it needs was a manual Project Settings edit. Both
// are mechanical, so the broker can do them when pointed at a project that has
// a project.godot but no addon.
//
// Writing into a user's project is the one thing this module does that the rest
// of the broker never does. Section 6.5's no-direct-file-writes rule protects a
// live editor session, which is why installAddon refuses outright while an
// editor bridge is connected: Godot does not pick up a newly added GDExtension
// without a restart anyway, and rewriting project.godot underneath a running
// editor would race its own writes.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isSafeEntryName, readZip } from "./zip.ts";

export const ADDON_DIR = path.join("addons", "conduit");
const VERSION_MARKER = ".conduit-version";
const ZIP_PREFIX = "addons/conduit/";
const AUTOLOAD_NAME = "ConduitRuntime";
const AUTOLOAD_VALUE = '"*res://addons/conduit/conduit_runtime.tscn"';
const RELEASES = "https://github.com/Advik-B/ConduitMCP/releases/download";

export type AddonState =
  /** The project has no addons/conduit at all. */
  | "missing"
  /** Installed by this broker, version marker matches. */
  | "current"
  /** Installed by this broker, version marker does not match. */
  | "stale"
  /** Present without a marker: extracted by hand. Never overwritten silently. */
  | "unmanaged";

export interface AddonDetection {
  projectValid: boolean;
  state: AddonState;
  installedVersion: string | null;
  autoloadPresent: boolean;
}

export interface InstallOptions {
  projectPath: string;
  version: string;
  /** CONDUIT_ADDON_SOURCE: a local zip, an unpacked directory, or a URL. */
  source?: string | null;
  /** Also register the ConduitRuntime autoload in project.godot. */
  autoload?: boolean;
  /** Replace an unmanaged or current install. */
  force?: boolean;
}

export interface InstallResult {
  installed: boolean;
  version: string;
  source: string;
  files: string[];
  autoloadAdded: boolean;
  backup: string | null;
}

export class AddonError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function projectFile(projectPath: string): string {
  return path.join(projectPath, "project.godot");
}

function addonPath(projectPath: string, ...rest: string[]): string {
  return path.join(projectPath, ADDON_DIR, ...rest);
}

function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Whether project.godot already registers the ConduitRuntime autoload. */
export function hasAutoload(projectGodot: string): boolean {
  return new RegExp(`^\\s*${AUTOLOAD_NAME}\\s*=`, "m").test(projectGodot);
}

/**
 * Inspect a directory: is it a Godot project, is the addon there, is it the
 * version this broker expects, and is the autoload registered. Filesystem only,
 * cheap enough to run at startup before the MCP transport is up.
 */
export function detectAddon(projectPath: string, expectedVersion: string): AddonDetection {
  const projectGodot = readIfPresent(projectFile(projectPath));
  if (projectGodot === null) {
    return { projectValid: false, state: "missing", installedVersion: null, autoloadPresent: false };
  }
  const autoloadPresent = hasAutoload(projectGodot);
  if (!fs.existsSync(addonPath(projectPath, "conduit.gdextension"))) {
    return { projectValid: true, state: "missing", installedVersion: null, autoloadPresent };
  }
  const marker = readIfPresent(addonPath(projectPath, VERSION_MARKER))?.trim() ?? null;
  if (!marker) {
    return { projectValid: true, state: "unmanaged", installedVersion: null, autoloadPresent };
  }
  return {
    projectValid: true,
    state: marker === expectedVersion ? "current" : "stale",
    installedVersion: marker,
    autoloadPresent,
  };
}

function defaultZipUrl(version: string): string {
  return `${RELEASES}/v${version}/conduit-addon-v${version}.zip`;
}

function checksumsUrl(version: string): string {
  return `${RELEASES}/v${version}/SHA256SUMS.txt`;
}

async function fetchBytes(url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new AddonError("addon_download_failed", `could not reach ${url}: ${String(error)}`, true);
  }
  if (!response.ok) {
    throw new AddonError("addon_download_failed", `${url} returned HTTP ${response.status}`, response.status >= 500);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Verify a downloaded zip against the SHA256SUMS.txt published beside it. The
 * release publishes both, so a download that does not match is a corrupted or
 * substituted asset and the install fails closed rather than unpacking it.
 */
async function verifyChecksum(zip: Buffer, version: string, assetName: string): Promise<void> {
  const sums = (await fetchBytes(checksumsUrl(version))).toString("utf8");
  const expected = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1]?.replace(/^\*/, "") === assetName)?.[0];
  if (!expected) {
    throw new AddonError("addon_checksum_missing", `${assetName} is not listed in SHA256SUMS.txt for v${version}`);
  }
  const actual = createHash("sha256").update(zip).digest("hex");
  if (actual !== expected) {
    throw new AddonError(
      "addon_checksum_mismatch",
      `${assetName} hashed to ${actual} but the release lists ${expected}; refusing to install`,
    );
  }
}

interface StagedFile {
  relative: string;
  data: Buffer;
}

/** Entries under addons/conduit/, with that prefix stripped. */
function stageFromZip(zip: Buffer): StagedFile[] {
  const staged: StagedFile[] = [];
  for (const entry of readZip(zip)) {
    if (!isSafeEntryName(entry.name)) {
      throw new AddonError("addon_unsafe_archive", `archive entry ${entry.name} is not a safe relative path`);
    }
    if (!entry.name.startsWith(ZIP_PREFIX)) {
      continue;
    }
    staged.push({ relative: entry.name.slice(ZIP_PREFIX.length), data: entry.data });
  }
  if (staged.length === 0) {
    throw new AddonError("addon_source_invalid", `archive contains no ${ZIP_PREFIX} entries`);
  }
  return staged;
}

/** An already-unpacked source: either the addon directory itself or a tree containing it. */
function stageFromDirectory(dir: string): StagedFile[] {
  const root = fs.existsSync(path.join(dir, "conduit.gdextension")) ? dir : path.join(dir, ADDON_DIR);
  if (!fs.existsSync(path.join(root, "conduit.gdextension"))) {
    throw new AddonError("addon_source_invalid", `${dir} contains no conduit.gdextension`);
  }
  const staged: StagedFile[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, relative);
      } else if (entry.isFile()) {
        staged.push({ relative, data: fs.readFileSync(full) });
      }
    }
  };
  walk(root, "");
  return staged;
}

async function resolveSource(options: InstallOptions): Promise<{ files: StagedFile[]; description: string }> {
  const source = options.source ?? null;
  if (source && !/^https?:\/\//.test(source)) {
    const stat = fs.existsSync(source) ? fs.statSync(source) : null;
    if (!stat) {
      throw new AddonError("addon_source_invalid", `CONDUIT_ADDON_SOURCE ${source} does not exist`);
    }
    if (stat.isDirectory()) {
      return { files: stageFromDirectory(source), description: source };
    }
    return { files: stageFromZip(fs.readFileSync(source)), description: source };
  }

  const url = source ?? defaultZipUrl(options.version);
  const zip = await fetchBytes(url);
  // Only the canonical release asset can be checked: an explicit URL is the
  // caller vouching for their own source.
  if (!source) {
    await verifyChecksum(zip, options.version, `conduit-addon-v${options.version}.zip`);
  }
  return { files: stageFromZip(zip), description: url };
}

/**
 * Add the ConduitRuntime autoload to project.godot, preserving everything else
 * in the file including comments and its existing line endings. Returns the
 * rewritten text, or null when the entry is already there.
 */
export function withAutoload(projectGodot: string): string | null {
  if (hasAutoload(projectGodot)) {
    return null;
  }
  const newline = projectGodot.includes("\r\n") ? "\r\n" : "\n";
  const entry = `${AUTOLOAD_NAME}=${AUTOLOAD_VALUE}`;
  const lines = projectGodot.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => line.trim() === "[autoload]");
  if (sectionIndex === -1) {
    const trimmed = projectGodot.replace(/\s+$/, "");
    return `${trimmed}${newline}${newline}[autoload]${newline}${newline}${entry}${newline}`;
  }
  // Insert at the end of the existing section, before the next [section] header.
  let insertAt = lines.length;
  for (let i = sectionIndex + 1; i < lines.length; i++) {
    if (lines[i]?.trimStart().startsWith("[")) {
      insertAt = i;
      break;
    }
  }
  while (insertAt > sectionIndex + 1 && lines[insertAt - 1]?.trim() === "") {
    insertAt--;
  }
  lines.splice(insertAt, 0, entry);
  return lines.join(newline);
}

function writeStaged(target: string, files: StagedFile[]): string[] {
  const written: string[] = [];
  for (const file of files) {
    const destination = path.join(target, file.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.data);
    written.push(path.posix.join("addons", "conduit", file.relative));
  }
  return written;
}

/**
 * Install the addon into a Godot project. Callers must have checked that no
 * editor bridge is connected; see the module comment for why that is not
 * optional.
 */
export async function installAddon(options: InstallOptions): Promise<InstallResult> {
  const { projectPath, version } = options;
  const detection = detectAddon(projectPath, version);
  if (!detection.projectValid) {
    throw new AddonError("not_a_godot_project", `${projectPath} has no project.godot`);
  }
  if (detection.state === "current" && !options.force) {
    throw new AddonError("already_installed", `addon v${version} is already installed; pass force=true to reinstall`);
  }
  if (detection.state === "unmanaged" && !options.force) {
    throw new AddonError(
      "already_installed",
      `${ADDON_DIR} exists but was not installed by Conduit (no ${VERSION_MARKER}); pass force=true to replace it`,
    );
  }

  const { files, description } = await resolveSource(options);

  // Stage beside the destination, then swap: an interrupted install leaves the
  // previous addon intact rather than a half-written one. Renaming over an
  // existing directory fails on Windows, so the old copy goes first.
  const staging = path.join(projectPath, "addons", ".conduit-install-tmp");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  let written: string[];
  let swapped = false;
  try {
    written = writeStaged(staging, files);
    const destination = addonPath(projectPath);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
    swapped = true;
  } finally {
    // Only clean up a staging directory that never made it into place. If the
    // rename failed after the old addon was removed (Windows can still hold a
    // handle on a loaded .dll), the staged copy is the only complete one there
    // is, and deleting it would leave the project with no addon at all.
    if (!swapped) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  // Written last: an install that dies before this reads back as unmanaged,
  // which prompts a reinstall rather than being mistaken for current.
  fs.writeFileSync(addonPath(projectPath, VERSION_MARKER), `${version}\n`);
  written.push(path.posix.join("addons", "conduit", VERSION_MARKER));

  let autoloadAdded = false;
  let backup: string | null = null;
  if (options.autoload !== false) {
    const file = projectFile(projectPath);
    const current = fs.readFileSync(file, "utf8");
    const updated = withAutoload(current);
    if (updated !== null) {
      backup = `${file}.conduit-backup`;
      fs.writeFileSync(backup, current);
      fs.writeFileSync(file, updated);
      autoloadAdded = true;
    }
  }

  return { installed: true, version, source: description, files: written, autoloadAdded, backup };
}
