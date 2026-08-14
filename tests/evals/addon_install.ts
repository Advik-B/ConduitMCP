#!/usr/bin/env bun
// Addon auto-install acceptance runner. Proves the claim the feature actually
// makes: point the broker at a directory that is a Godot project but has no
// addon, and the project ends up in a state Godot loads the extension from.
//
// Nothing here reaches the network. The addon zip is built locally from the
// debug cargo output with scripts/package-addon.ts --partial and handed to the
// broker through CONDUIT_ADDON_SOURCE, which is exactly the path a user with a
// pre-downloaded zip takes.
//
// Covered:
//   - a directory with no project.godot is reported invalid, not installed into;
//   - CONDUIT_AUTO_INSTALL=1 on a valid project with no addon installs it and
//     registers the ConduitRuntime autoload;
//   - Godot launched headless on the result connects its editor bridge and
//     answers gd_ping, which is the only proof the addon really loaded;
//   - a second broker against the installed project reports state "current";
//   - gd_addon_install refuses while an editor bridge is connected.
//
// Run with `bun tests/evals/addon_install.ts` (needs GODOT_BIN).

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { conduitEnv, godotCommand, killTree, repoRoot, resolveGodot, runtimeDir, waitForEditor } from "./harness.ts";

const RUNTIME_DIR = runtimeDir("addon");
const WORK_DIR = mkdtempSync(join(os.tmpdir(), "conduit-addon-eval-"));
const PROJECT_DIR = join(WORK_DIR, "project");
const EMPTY_DIR = join(WORK_DIR, "not-a-project");
const ZIP_DIR = join(WORK_DIR, "dist");
const EDITOR_LOG = join(RUNTIME_DIR, "editor.log");

// The host's bridge library. --partial packages whichever are present, so a
// local run needs only this platform's.
const HOST_LIBRARY =
  process.platform === "win32" ? "conduit.dll" : process.platform === "darwin" ? "libconduit.dylib" : "libconduit.so";

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

async function run(cmd: string[], cwd: string): Promise<number> {
  return Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" }).exited;
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  if (result.isError) {
    throw new Error(`${name} failed: ${text}`);
  }
  return JSON.parse(text);
}

/** Call a tool expecting failure, returning its error text. */
async function callExpectingError(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  if (!result.isError) {
    throw new Error(`${name} unexpectedly succeeded: ${text}`);
  }
  return text;
}

async function startBroker(env: Record<string, string>, label: string, args: string[] = []): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(repoRoot, "broker", "src", "index.ts"), ...args],
    env,
  });
  const client = new Client({ name: label, version: "0.1.0" });
  await client.connect(transport);
  return client;
}

/** Wait for the broker's own view of the install to settle: it runs after the
 * MCP handshake by design, so gd_status is the place it becomes visible. */
async function waitForAddonState(client: Client, want: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    last = (await callJson(client, "gd_status")).addon;
    if (last?.state === want) {
      return last;
    }
    await Bun.sleep(300);
  }
  // Mark the timeout so a hung install is distinguishable from one that failed
  // fast; this runs unattended in ci:phases, where the detail string is all
  // anyone gets.
  return { ...(last ?? {}), timed_out_after_ms: timeoutMs };
}

function projectGodot(): string {
  return [
    "config_version=5",
    "",
    "[application]",
    "",
    'config/name="Addon Install Eval"',
    'run/main_scene="res://main.tscn"',
    "",
    "[rendering]",
    "",
    'renderer/rendering_method="gl_compatibility"',
    'renderer/rendering_method.mobile="gl_compatibility"',
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const godot = resolveGodot();
  console.log(`Godot: ${godot}`);
  console.log(`Work dir: ${WORK_DIR}`);

  console.log("\nBuilding bridge (cargo build -p conduit) ...");
  if ((await run(["cargo", "build", "-p", "conduit"], repoRoot)) !== 0) {
    throw new Error("bridge build failed");
  }
  if (!existsSync(join(repoRoot, "target", "debug", HOST_LIBRARY))) {
    throw new Error(`no ${HOST_LIBRARY} in target/debug after the build`);
  }

  console.log("\nPackaging the addon zip locally (no network) ...");
  mkdirSync(ZIP_DIR, { recursive: true });
  const packaged = await run(
    ["bun", join("scripts", "package-addon.ts"), "--artifacts", join("target", "debug"), "--out", ZIP_DIR, "--partial"],
    repoRoot,
  );
  if (packaged !== 0) {
    throw new Error("package-addon failed");
  }
  const version = readFileSync(join(repoRoot, "Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)?.[1];
  if (!version) {
    throw new Error("no version in Cargo.toml");
  }
  const zipPath = join(ZIP_DIR, `conduit-addon-v${version}.zip`);
  if (!existsSync(zipPath)) {
    throw new Error(`expected ${zipPath}`);
  }

  // A Godot project with a scene but deliberately no addons/ and no autoload.
  mkdirSync(PROJECT_DIR, { recursive: true });
  mkdirSync(EMPTY_DIR, { recursive: true });
  writeFileSync(join(PROJECT_DIR, "project.godot"), projectGodot());
  cpSync(join(repoRoot, "example-project", "main.tscn"), join(PROJECT_DIR, "main.tscn"));
  cpSync(join(repoRoot, "example-project", "player.gd"), join(PROJECT_DIR, "player.gd"));
  cpSync(join(repoRoot, "example-project", "player.gd.uid"), join(PROJECT_DIR, "player.gd.uid"));

  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });

  const env = (project: string, extra: Record<string, string> = {}) =>
    conduitEnv(RUNTIME_DIR, { CONDUIT_PROJECT: project, CONDUIT_ADDON_SOURCE: zipPath, ...extra });

  console.log("\nA directory that is not a Godot project ...");
  {
    // Detection runs before the transport comes up, so the first gd_status
    // already carries the verdict; there is nothing to wait for here.
    const client = await startBroker(env(EMPTY_DIR, { CONDUIT_AUTO_INSTALL: "1" }), "addon-eval-invalid");
    const status = (await callJson(client, "gd_status")).addon;
    record("not-a-project reported, not installed into", status?.project_valid === false, `project_valid=${status?.project_valid}`);
    record("no addons directory created", !existsSync(join(EMPTY_DIR, "addons")), `${join(EMPTY_DIR, "addons")} absent`);
    await client.close();
  }

  console.log("\nAuto-install disabled: detected but not written ...");
  {
    const client = await startBroker(env(PROJECT_DIR), "addon-eval-optout");
    const status = (await callJson(client, "gd_status")).addon;
    record("state reported missing without the opt-in", status?.state === "missing", `state=${status?.state}`);
    record("auto_install reported off", status?.auto_install === false, `auto_install=${status?.auto_install}`);
    record("nothing written without the opt-in", !existsSync(join(PROJECT_DIR, "addons")), "addons/ absent");
    await client.close();
  }

  // Driven through the command-line flags rather than the environment, so the
  // CLI-beats-environment contract of whitepaper section 15 is exercised: the
  // environment here points CONDUIT_ADDON_SOURCE at a path that does not exist,
  // and the install must still succeed from the flag.
  console.log("\nAuto-install enabled, via --auto-install and --addon-source ...");
  {
    const client = await startBroker(
      conduitEnv(RUNTIME_DIR, { CONDUIT_PROJECT: PROJECT_DIR, CONDUIT_ADDON_SOURCE: join(WORK_DIR, "no-such-source.zip") }),
      "addon-eval-install",
      ["--auto-install", "--addon-source", zipPath],
    );
    const status = await waitForAddonState(client, "current", 60_000);
    record(
      "addon reports current after install",
      status?.state === "current",
      `state=${status?.state}, error=${status?.last_install_error}${status?.timed_out_after_ms ? `, timed out after ${status.timed_out_after_ms}ms` : ""}`,
    );
    record("--addon-source beat CONDUIT_ADDON_SOURCE", status?.last_attempt_source === zipPath, `source=${status?.last_attempt_source}`);
    record("autoload registered", status?.autoload === true, `autoload=${status?.autoload}`);

    const addonDir = join(PROJECT_DIR, "addons", "conduit");
    record("gdextension manifest written", existsSync(join(addonDir, "conduit.gdextension")), "addons/conduit/conduit.gdextension");
    record("host library written", existsSync(join(addonDir, "bin", HOST_LIBRARY)), `addons/conduit/bin/${HOST_LIBRARY}`);
    record(
      "version marker matches the broker",
      readFileSync(join(addonDir, ".conduit-version"), "utf8").trim() === version,
      `.conduit-version=${readFileSync(join(addonDir, ".conduit-version"), "utf8").trim()}, broker=${version}`,
    );
    const projectText = readFileSync(join(PROJECT_DIR, "project.godot"), "utf8");
    record(
      "autoload line in project.godot",
      projectText.includes('ConduitRuntime="*res://addons/conduit/conduit_runtime.tscn"'),
      "ConduitRuntime autoload present",
    );
    record("rest of project.godot preserved", projectText.includes('run/main_scene="res://main.tscn"'), "main_scene intact");
    record("backup written before the edit", existsSync(join(PROJECT_DIR, "project.godot.conduit-backup")), "project.godot.conduit-backup");
    await client.close();
  }

  // The only claim that matters: Godot loads what was installed. The manifest
  // the installer wrote points at res://addons/conduit/bin/, so a bridge that
  // connects proves both the layout and the library are right.
  console.log("\nLaunching Godot headless on the installed project ...");
  const editor = Bun.spawn(
    godotCommand(godot, ["--headless", "--editor", "--path", PROJECT_DIR, "--log-file", EDITOR_LOG], false),
    { cwd: repoRoot, env: env(PROJECT_DIR), stdout: "inherit", stderr: "inherit" },
  );
  let client: Client | null = null;
  try {
    await waitForEditor(RUNTIME_DIR, 120_000, PROJECT_DIR);
    record("editor bridge endpoint appeared", true, "the installed extension loaded and bound");

    client = await startBroker(env(PROJECT_DIR), "addon-eval-connected");
    const ping = await callJson(client, "gd_ping");
    record("gd_ping round-trips through the installed addon", ping?.ok !== false, JSON.stringify(ping));

    const status = await callJson(client, "gd_status");
    record("second broker sees the addon as current", status.addon?.state === "current", `state=${status.addon?.state}`);
    record("editor reported connected", status.editor?.connected === true, `engine ${status.editor?.engine_version}`);

    // Godot only loads a GDExtension at startup, and project.godot belongs to
    // the running editor, so installing now would be both useless and unsafe.
    const refusal = await callExpectingError(client, "gd_addon_install", { force: true });
    record("install refused while an editor is connected", /editor/i.test(refusal), refusal.slice(0, 120));
  } finally {
    if (client) {
      await client.close();
    }
    killTree(editor);
  }

  console.log("");
  const failed = checks.filter((c) => !c.pass);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log(`Failed: ${failed.map((c) => c.name).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  // Best-effort: on Windows the editor process still holds the loaded .dll for
  // a moment after killTree, so a leftover temp directory is not a failure.
  for (const dir of [WORK_DIR, RUNTIME_DIR]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      console.log(`(left ${dir} behind; the OS still holds a handle on it)`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
