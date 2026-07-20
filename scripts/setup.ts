#!/usr/bin/env bun
// Dev environment setup: fetch the Godot editor binary and install broker deps.
// Idempotent; run with `bun scripts/setup.ts`. Bun is preferred over node for
// all tooling in this project.

import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const toolsDir = join(repoRoot, "tools", "godot");
const binPointer = join(toolsDir, "GODOT_BIN");

async function main(): Promise<void> {
  const godotBin = await ensureGodot();
  writeFileSync(binPointer, `${godotBin}\n`);
  await installBrokerDeps();
  await fetchCargoDeps();

  console.log("");
  console.log("Setup complete.");
  console.log(`Godot binary: ${godotBin}`);
  console.log(`Add to your shell for this session:`);
  console.log(`  export GODOT_BIN=${godotBin}`);
}

async function ensureGodot(): Promise<string> {
  const preset = process.env.GODOT_BIN;
  if (preset && existsSync(preset)) {
    console.log(`Using preset GODOT_BIN: ${preset}`);
    return preset;
  }

  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      `Automated Godot download supports linux x64 only; got ${process.platform}/${process.arch}. ` +
        `Set GODOT_BIN to a Godot 4.4+ binary and re-run.`,
    );
  }

  mkdirSync(toolsDir, { recursive: true });

  const existing = findGodotBinary();
  if (existing) {
    console.log(`Godot already present: ${existing}`);
    return existing;
  }

  const tag = await resolveLatestTag();
  const asset = `Godot_v${tag}_linux.x86_64`;
  const url = `https://github.com/godotengine/godot/releases/download/${tag}/${asset}.zip`;
  const zipPath = join(toolsDir, `${asset}.zip`);

  console.log(`Downloading Godot ${tag} ...`);
  await download(url, zipPath);

  console.log("Extracting ...");
  await run(["unzip", "-o", zipPath, "-d", toolsDir]);

  const binary = findGodotBinary();
  if (!binary) {
    throw new Error(`Extraction did not yield a Godot binary in ${toolsDir}`);
  }
  chmodSync(binary, 0o755);

  const version = await capture([binary, "--version"]);
  console.log(`Installed Godot: ${version.trim()}`);
  return binary;
}

async function resolveLatestTag(): Promise<string> {
  // Override to pin a specific version (e.g. GODOT_VERSION=4.6-stable) when the
  // bundled gdext API and the newest engine release disagree.
  const override = process.env.GODOT_VERSION;
  if (override) {
    return override;
  }
  const response = await fetch("https://github.com/godotengine/godot/releases/latest", {
    redirect: "manual",
  });
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Could not resolve the latest Godot release (no redirect location)");
  }
  const tag = location.split("/").pop();
  if (!tag) {
    throw new Error(`Unexpected release URL: ${location}`);
  }
  return tag;
}

function findGodotBinary(): string | null {
  if (!existsSync(toolsDir)) {
    return null;
  }
  const match = readdirSync(toolsDir).find(
    (name) => name.startsWith("Godot_v") && name.endsWith("linux.x86_64"),
  );
  return match ? join(toolsDir, match) : null;
}

async function download(url: string, dest: string): Promise<void> {
  // curl handles the GitHub -> CDN redirect and the large binary transfer more
  // reliably than fetch here; the script stays bun-orchestrated either way.
  await run(["curl", "-fL", "--retry", "3", "-o", dest, url]);
}

async function installBrokerDeps(): Promise<void> {
  // Install at the workspace root so broker deps hoist into a root node_modules
  // that repo-level dev scripts (tests/evals) can also resolve.
  console.log("Installing workspace dependencies (bun install) ...");
  await run(["bun", "install"], repoRoot);
}

async function fetchCargoDeps(): Promise<void> {
  console.log("Fetching Rust dependencies (cargo fetch) ...");
  await run(["cargo", "fetch"], join(repoRoot, "bridge"));
}

async function run(cmd: string[], cwd: string = repoRoot): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${cmd.join(" ")}`);
  }
}

async function capture(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
