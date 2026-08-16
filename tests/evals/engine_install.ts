#!/usr/bin/env bun
// Engine install acceptance runner. Proves the claim the feature makes: a
// machine with no Godot can get one, and the broker then finds it by itself.
//
// Nothing here reaches the network and nothing here needs a real engine. The
// "engine" is a synthesised archive holding a stub executable named the way the
// host platform's real archive names it, handed to the installer through
// CONDUIT_ENGINE_SOURCE -- which is exactly the path a user with a
// pre-downloaded archive or an air-gapped machine takes. What is under test is
// the resolve-verify-extract-locate chain and the guards around it, not Godot.
//
// Deliberately does not call harness.resolveGodot(): unlike the addon runner,
// this one has no reason to launch anything, and requiring GODOT_BIN would make
// it fail on a machine that is precisely the case it exists to cover.
//
// Covered:
//   - --install-godot installs with no --project, which resolveConfig requires;
//   - the install is idempotent, and reports rather than redoing itself;
//   - the standard and .NET builds of one version coexist;
//   - an engine the installer did not write is not replaced without force;
//   - resolveGodotBinary finds the result afterwards;
//   - nothing reaches stdout, which carries the MCP protocol.
//
// Run with `bun tests/evals/engine_install.ts`.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { listInstalledEngines } from "../../broker/src/godot-install.ts";
import { resolveGodotBinary } from "../../broker/src/godot-locate.ts";
import { repoRoot } from "./harness.ts";

const WORK = mkdtempSync(join(os.tmpdir(), "conduit-engine-eval-"));
const SOURCE = join(WORK, "source");
const ENGINES = join(WORK, "engines");
const TAG = "9.9.9-test";

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}

/** The executable name the real archive for this platform unpacks. */
function stubBinaryName(): string {
  if (process.platform === "win32") {
    return `Godot_v${TAG}_win64.exe`;
  }
  return `Godot_v${TAG}_linux.x86_64`;
}

function writeStubSource(): void {
  rmSync(SOURCE, { recursive: true, force: true });
  mkdirSync(SOURCE, { recursive: true });
  if (process.platform === "darwin") {
    const macos = join(SOURCE, "Godot.app", "Contents", "MacOS");
    mkdirSync(macos, { recursive: true });
    writeFileSync(join(macos, "Godot"), "#!/bin/sh\necho stub\n");
  } else {
    writeFileSync(join(SOURCE, stubBinaryName()), "#!/bin/sh\necho stub\n");
  }
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function installCli(extra: string[] = []): Promise<Run> {
  const proc = Bun.spawn(
    [
      "bun",
      join(repoRoot, "broker", "src", "index.ts"),
      "--install-godot",
      "--godot-version",
      TAG,
      "--engine-source",
      SOURCE,
      "--engine-dir",
      ENGINES,
      ...extra,
    ],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe", env: { ...process.env, CONDUIT_PROJECT: "", CONDUIT_SOCK: "" } },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

async function main(): Promise<void> {
  console.log("Engine install acceptance");
  writeStubSource();

  // The whole point: no --project and no CONDUIT_PROJECT, which the server path
  // requires and the installer must not.
  const first = await installCli();
  record(
    "installs without a project configured",
    first.code === 0 && /installed Godot/.test(first.stderr),
    first.code === 0 ? first.stderr.trim().split("\n").pop() ?? "" : `exit ${first.code}: ${first.stderr.trim()}`,
  );

  record(
    "keeps stdout clear for the MCP transport",
    first.stdout === "",
    first.stdout === "" ? "nothing on stdout" : `stdout carried ${JSON.stringify(first.stdout.slice(0, 80))}`,
  );

  const installedDir = join(ENGINES, TAG);
  record(
    "writes the marker that marks the install as its own",
    existsSync(join(installedDir, ".conduit-engine")),
    `.conduit-engine in ${TAG}/`,
  );

  const second = await installCli();
  record(
    "is idempotent, reporting rather than reinstalling",
    second.code === 0 && /already installed/.test(second.stderr),
    second.stderr.trim().split("\n").pop() ?? "",
  );

  const mono = await installCli(["--godot-mono"]);
  const builds = listInstalledEngines(ENGINES);
  record(
    "installs the .NET build alongside the standard one",
    mono.code === 0 && builds.length === 2 && builds.some((build) => build.mono) && builds.some((build) => !build.mono),
    builds.map((build) => `${build.tag}${build.mono ? "-mono" : ""}`).join(", ") || "none",
  );

  // An engine somebody else put there, which force exists for.
  const foreign = join(ENGINES, "8.8.8-foreign");
  mkdirSync(foreign, { recursive: true });
  if (process.platform === "darwin") {
    mkdirSync(join(foreign, "Godot.app", "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(foreign, "Godot.app", "Contents", "MacOS", "Godot"), "");
  } else {
    writeFileSync(join(foreign, stubBinaryName().replace(TAG, "8.8.8-foreign")), "");
  }
  const clobber = await installCli(["--godot-version", "8.8.8-foreign"]);
  record(
    "refuses to replace an engine it did not install",
    clobber.code === 1 && /engine_already_installed/.test(clobber.stderr),
    clobber.stderr.trim().split("\n").pop() ?? `exit ${clobber.code}`,
  );

  // PATH emptied so a real Godot on the machine cannot decide this.
  const resolved = resolveGodotBinary(null, { CONDUIT_ENGINE_DIR: ENGINES, PATH: "", Path: "" } as NodeJS.ProcessEnv);
  record(
    "the broker finds the installed engine afterwards",
    resolved != null && resolved.path.startsWith(ENGINES),
    resolved ? `${resolved.source}: ${resolved.path}` : "resolved nothing",
  );

  record(
    "leaves no staging directory behind",
    readdirSync(ENGINES).every((name) => !name.includes("install-tmp")),
    readdirSync(ENGINES).join(", "),
  );

  const failed = checks.filter((check) => !check.pass);
  console.log("");
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
  rmSync(WORK, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
