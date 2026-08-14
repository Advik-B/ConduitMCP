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

// The official Windows archive extracts to Godot_v<version>_win64.exe. The
// _console variant is a console-subsystem wrapper that would keep a terminal
// attached to a detached editor, so it is skipped (same rule as
// scripts/setup.ts).
function windowsArchiveBinary(name: string): boolean {
  return name.startsWith("Godot_v") && name.endsWith(".exe") && !name.includes("_console");
}

// Directories that hold an extracted Godot archive rather than a binary
// directly: return the first archive-named executable inside.
function firstArchiveBinary(dir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const match = entries.filter(windowsArchiveBinary).sort().at(-1);
  return match ? path.join(dir, match) : null;
}

interface Location {
  /** An exact file to test. */
  file?: string;
  /** A directory to scan for an extracted Godot archive. */
  dir?: string;
}

function wellKnownLocations(env: NodeJS.ProcessEnv): Location[] {
  const home = homeDir();
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return [
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
      { file: "/Applications/Godot.app/Contents/MacOS/Godot" },
      { file: path.join(home, "Applications", "Godot.app", "Contents", "MacOS", "Godot") },
      { file: "/opt/homebrew/bin/godot" },
      { file: "/usr/local/bin/godot" },
    ];
  }
  return [
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
      const found = firstArchiveBinary(location.dir);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/** Human-readable list of where the search looked, for the not-found error. */
export function searchedLocations(env: NodeJS.ProcessEnv = process.env): string[] {
  const places = [`PATH (${PATH_NAMES.join(", ")})`];
  for (const location of wellKnownLocations(env)) {
    const place = location.file ?? location.dir;
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
