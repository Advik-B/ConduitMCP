// Engine binary resolution for gd_editor_launch. Attaching to a running editor
// never needs one: the endpoint comes from the project-path hash (section 7.2),
// and the bridge locates its own engine through Os::get_executable_path for the
// two handlers that shell out. Only launching an editor the broker does not yet
// have needs a path, so the search runs lazily on first use rather than at boot.
//
// GODOT_BIN is deliberately not read here. It is the development and CI variable
// (tests/evals/harness.ts, scripts/setup.ts); keeping it out of the broker is
// what lets docs/environment.md separate runtime knobs from build tooling.

import { readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type GodotSource = "configured" | "path" | "well-known";

export interface GodotBinary {
  path: string;
  source: GodotSource;
}

// Bare command names to look for on PATH, most specific first so a system with
// both godot4 and a godot that is some other tool prefers the versioned name.
const PATH_NAMES = ["godot4", "godot", "Godot"];

function homeDir(): string {
  return os.homedir();
}

/**
 * Root holding one directory per engine this broker installed
 * (godot-install.ts). It lives here rather than beside the installer because
 * resolution has to know about it too, and the installer already depends on
 * this module.
 *
 * Read through env rather than straight off os.homedir() so a test can point it
 * somewhere empty; a developer's real engine directory would otherwise decide
 * whether "nothing is installed" tests pass.
 */
export function engineDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONDUIT_ENGINE_DIR || path.join(homeDir(), ".conduit", "engines");
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

// Windows resolves a bare name through PATHEXT; everything else expects the
// extension to be part of the name already.
function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") {
    return [""];
  }
  const raw = env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  return raw.split(";").filter((ext) => ext.length > 0);
}

/** Scan PATH for a Godot command. Pure filesystem checks, no subprocess. */
function findOnPath(env: NodeJS.ProcessEnv): string | null {
  const raw = env.PATH || env.Path || "";
  if (!raw) {
    return null;
  }
  const extensions = pathExtensions(env);
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of PATH_NAMES) {
      for (const ext of extensions) {
        const candidate = path.join(dir, `${name}${ext}`);
        if (isFile(candidate)) {
          return candidate;
        }
      }
    }
  }
  return null;
}

// The name an extracted official archive gives the editor binary, per platform.
// Windows is Godot_v<version>_win64.exe; the _console variant is a
// console-subsystem wrapper that would keep a terminal attached to a detached
// editor, so it is skipped (same rule as scripts/setup.ts). Linux is
// Godot_v<version>_linux.<arch> with no extension. macOS is not a top-level file
// at all, which findEngineBinary handles separately.
function archiveBinary(name: string, platform: string = process.platform): boolean {
  if (platform === "win32") {
    return name.startsWith("Godot_v") && name.endsWith(".exe") && !name.includes("_console");
  }
  return /^Godot_v.*_linux\.(x86_64|x86_32|arm64|arm32)$/.test(name);
}

/**
 * The editor binary inside a directory holding an extracted Godot archive, or
 * null. Used both for the well-known install locations and for reading back
 * what godot-install.ts just unpacked, so the two always agree on what counts
 * as an engine.
 */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The executable inside a macOS app bundle in this directory.
 *
 * The standard build ships Godot.app and the .NET build Godot_mono.app, and the
 * executable inside is not reliably named after either. Scanning for the bundle
 * and taking what is in Contents/MacOS beats hardcoding names that differ per
 * build and could change per release.
 */
function macAppBinary(dir: string): string | null {
  for (const name of safeReaddir(dir).sort()) {
    if (!name.endsWith(".app")) {
      continue;
    }
    const macos = path.join(dir, name, "Contents", "MacOS");
    const executable = safeReaddir(macos).sort().at(0);
    if (executable && isFile(path.join(macos, executable))) {
      return path.join(macos, executable);
    }
  }
  return null;
}

/** An engine binary sitting directly in this directory, ignoring subdirectories. */
function binaryDirectlyIn(dir: string, platform: string): string | null {
  if (platform === "darwin") {
    return macAppBinary(dir);
  }
  // Highest-sorting name wins, so a directory holding several versions offers
  // the newest rather than whichever the filesystem lists first.
  const match = safeReaddir(dir)
    .filter((name) => archiveBinary(name, platform))
    .sort()
    .at(-1);
  return match && isFile(path.join(dir, match)) ? path.join(dir, match) : null;
}

/**
 * The editor binary inside a directory holding an extracted Godot archive, or
 * null. Used both for the well-known install locations and for reading back
 * what godot-install.ts just unpacked, so the two always agree on what counts
 * as an engine.
 *
 * Looks one level down as well as directly, because the two archive shapes
 * differ: the standard builds unpack a bare binary (or a .app) at the top,
 * while the .NET builds unpack a directory named for the build with the
 * executable and GodotSharp/ inside it.
 */
export function findEngineBinary(dir: string, platform: string = process.platform): string | null {
  const direct = binaryDirectlyIn(dir, platform);
  if (direct) {
    return direct;
  }
  for (const name of safeReaddir(dir).sort().reverse()) {
    const nested = path.join(dir, name);
    if (!isDirectory(nested) || name.endsWith(".app")) {
      continue;
    }
    const found = binaryDirectlyIn(nested, platform);
    if (found) {
      return found;
    }
  }
  return null;
}

interface Location {
  /** An exact file to test. */
  file?: string;
  /** A directory to scan for an extracted Godot archive. */
  dir?: string;
  /** A directory whose subdirectories each hold an extracted archive. */
  versions?: string;
}

function wellKnownLocations(env: NodeJS.ProcessEnv): Location[] {
  const home = homeDir();
  // Engines this broker installed come first: if it was asked to fetch one, that
  // is the one the user meant, ahead of an unrelated Steam or distro copy.
  const installed: Location = { versions: engineDir(env) };
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return [
      installed,
      { dir: path.join(localAppData, "Programs", "Godot") },
      { dir: path.join(localAppData, "Godot") },
      { dir: path.join(programFiles, "Godot") },
      { file: path.join(home, "scoop", "shims", "godot.exe") },
      { dir: path.join(home, "scoop", "apps", "godot", "current") },
      { dir: path.join(programFilesX86, "Steam", "steamapps", "common", "Godot Engine") },
    ];
  }
  if (process.platform === "darwin") {
    return [
      installed,
      { file: "/Applications/Godot.app/Contents/MacOS/Godot" },
      { file: path.join(home, "Applications", "Godot.app", "Contents", "MacOS", "Godot") },
      { file: "/opt/homebrew/bin/godot" },
      { file: "/usr/local/bin/godot" },
    ];
  }
  return [
    installed,
    { file: "/usr/bin/godot" },
    { file: "/usr/local/bin/godot" },
    { file: path.join(home, ".local", "bin", "godot") },
    { file: "/var/lib/flatpak/exports/bin/org.godotengine.Godot" },
    { file: path.join(home, ".local", "share", "flatpak", "exports", "bin", "org.godotengine.Godot") },
    { dir: path.join(home, ".steam", "steam", "steamapps", "common", "Godot Engine") },
  ];
}

function findWellKnown(env: NodeJS.ProcessEnv): string | null {
  for (const location of wellKnownLocations(env)) {
    if (location.file && isFile(location.file)) {
      return location.file;
    }
    if (location.dir) {
      const found = findEngineBinary(location.dir);
      if (found) {
        return found;
      }
    }
    if (location.versions) {
      const found = findInVersionDirs(location.versions);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Scan a root holding one subdirectory per installed version, newest-sorting
 * name first, and return the first engine binary found in one of them.
 *
 * Reverse name order means the newest version wins, and that a "<tag>-mono"
 * directory beats the plain "<tag>" beside it. That tie-break is safe rather
 * than merely incidental: the .NET build opens a GDScript project as happily as
 * the standard one, while the reverse is not true, so preferring it costs
 * nothing and helps a project that turns out to have C# in it.
 */
function findInVersionDirs(root: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const name of entries.sort().reverse()) {
    const found = findEngineBinary(path.join(root, name));
    if (found) {
      return found;
    }
  }
  return null;
}

/** Human-readable list of where the search looked, for the not-found error. */
export function searchedLocations(env: NodeJS.ProcessEnv = process.env): string[] {
  const places = [`PATH (${PATH_NAMES.join(", ")})`];
  for (const location of wellKnownLocations(env)) {
    const place = location.file ?? location.dir ?? location.versions;
    if (place) {
      places.push(place);
    }
  }
  return places;
}

/**
 * Resolve the engine binary: an explicit --godot/CONDUIT_GODOT value wins and is
 * used verbatim, then PATH, then the per-platform install locations. Returns
 * null when nothing is found, which callers report rather than throwing here.
 */
export function resolveGodotBinary(explicit: string | null, env: NodeJS.ProcessEnv = process.env): GodotBinary | null {
  if (explicit) {
    return { path: explicit, source: "configured" };
  }
  const onPath = findOnPath(env);
  if (onPath) {
    return { path: onPath, source: "path" };
  }
  const wellKnown = findWellKnown(env);
  if (wellKnown) {
    return { path: wellKnown, source: "well-known" };
  }
  return null;
}

/**
 * A caching wrapper over resolveGodotBinary. The scan touches the filesystem, so
 * it runs on first use and the answer is kept for the broker's lifetime; an
 * explicit path short-circuits it entirely.
 */
export class GodotResolver {
  private cached: GodotBinary | null = null;
  private resolved = false;

  constructor(private readonly explicit: string | null) {}

  resolve(): GodotBinary | null {
    if (!this.resolved) {
      this.cached = resolveGodotBinary(this.explicit);
      this.resolved = true;
    }
    return this.cached;
  }

  /** Drop the cached answer so a newly installed engine is picked up. */
  reset(): void {
    this.resolved = false;
    this.cached = null;
  }
}
