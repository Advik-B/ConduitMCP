#!/usr/bin/env bun
// Assemble the distributable Godot addon zip from prebuilt bridge libraries
// (whitepaper section 15). Scans --artifacts recursively for the per-platform
// libraries, stages addons/conduit/ with the distribution manifest, and zips.
// CI runs this on Linux; --partial permits an incomplete library set for local
// dry runs. Run with `bun scripts/package-addon.ts --artifacts <dir> --out <dir>`.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const LIBRARY_NAMES = ["libconduit.so", "conduit.dll", "libconduit.dylib"];

function cliValue(name: string): string | null {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === name) {
      return argv[i + 1] ?? null;
    }
    if (arg?.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return null;
}

function findLibraries(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (LIBRARY_NAMES.includes(entry) && !found.has(entry)) {
        found.set(entry, full);
      }
    }
  };
  walk(dir);
  return found;
}

// Every library file the manifest references must be staged, so a user on any
// supported platform gets a loadable addon.
function manifestLibraryNames(manifestPath: string): string[] {
  const text = readFileSync(manifestPath, "utf8");
  const names = new Set<string>();
  for (const match of text.matchAll(/res:\/\/addons\/conduit\/bin\/([^"]+)/g)) {
    const name = match[1];
    if (name) {
      names.add(name);
    }
  }
  return [...names];
}

async function zipDirectory(stagingDir: string, zipPath: string): Promise<void> {
  const cmd =
    process.platform === "win32"
      ? ["powershell", "-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -Path '${join(stagingDir, "addons")}' -DestinationPath '${zipPath}' -Force`]
      : ["zip", "-r", zipPath, "addons"];
  const proc = Bun.spawn(cmd, { cwd: stagingDir, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`zip failed (${code})`);
  }
}

async function main(): Promise<void> {
  const artifactsDir = cliValue("--artifacts");
  const outDir = cliValue("--out") ?? "dist";
  const partial = process.argv.includes("--partial");
  if (!artifactsDir || !existsSync(artifactsDir)) {
    throw new Error("pass --artifacts <dir> pointing at the built libraries");
  }

  const versionMatch = readFileSync(join(repoRoot, "Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m);
  if (!versionMatch?.[1]) {
    throw new Error("no version in Cargo.toml");
  }
  const version = versionMatch[1];

  const manifestSource = join(repoRoot, "packaging", "conduit.gdextension");
  const required = manifestLibraryNames(manifestSource);
  const libraries = findLibraries(resolve(artifactsDir));
  const missing = required.filter((name) => !libraries.has(name));
  if (missing.length > 0 && !partial) {
    throw new Error(`missing libraries: ${missing.join(", ")} (pass --partial for a local dry run)`);
  }
  if (libraries.size === 0) {
    throw new Error(`no bridge libraries found under ${artifactsDir}`);
  }

  const staging = join(resolve(outDir), "staging");
  const addonDir = join(staging, "addons", "conduit");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(addonDir, "bin"), { recursive: true });

  copyFileSync(manifestSource, join(addonDir, "conduit.gdextension"));
  copyFileSync(join(repoRoot, "example-project", "addons", "conduit", "conduit_runtime.tscn"), join(addonDir, "conduit_runtime.tscn"));
  copyFileSync(join(repoRoot, "LICENSE"), join(addonDir, "LICENSE"));
  for (const [name, path] of libraries) {
    copyFileSync(path, join(addonDir, "bin", name));
  }

  const zipPath = join(resolve(outDir), `conduit-addon-v${version}.zip`);
  rmSync(zipPath, { force: true });
  await zipDirectory(staging, zipPath);
  rmSync(staging, { recursive: true, force: true });

  console.log(`packaged ${zipPath}`);
  console.log(`libraries: ${[...libraries.keys()].join(", ")}${missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
