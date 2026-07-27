#!/usr/bin/env bun
// Record the README demo: drive a real Godot editor through the broker while
// capturing the display it renders to, then encode the two artifacts the
// README carries. Run with `bun run demo` (needs GODOT_BIN or tools/godot).
//
// The session runs against .demo-project, a throwaway copy of example-project.
// The demo saves scenes and writes scripts on camera, which is the point, and
// a copy keeps that out of the tracked tree. It has to be a sibling of
// example-project so the res://../target/debug/libconduit.so path in
// conduit.gdextension still resolves.
//
// Linux only: capture is Xvfb plus x11grab (docs/api-gaps.md).

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  conduitEnv,
  exampleProject,
  godotCommand,
  isLinux,
  killTree,
  repoRoot,
  resolveGodot,
  runtimeDir,
  startVirtualDisplay,
  waitForEditor,
} from "../../tests/evals/harness.ts";
import { Recorder, requireFfmpeg } from "./capture.ts";
import { probeDuration, writeGif, writeMp4 } from "./encode.ts";
import { Scenario } from "./scenario.ts";

const WIDTH = 1600;
const HEIGHT = 900;
const DEMO_PROJECT = join(repoRoot, ".demo-project");
const MEDIA_DIR = join(repoRoot, "docs", "media");
const RUNTIME_DIR = runtimeDir("demo");
const WORK_DIR = join(repoRoot, "target", "demo-capture");

async function main(): Promise<void> {
  if (!isLinux) {
    throw new Error("the demo recorder is Linux-only (Xvfb plus x11grab); see docs/api-gaps.md");
  }
  requireFfmpeg();
  const godot = resolveGodot();
  console.log(`Godot: ${godot}`);

  await buildBridge();
  materialiseDemoProject();
  await warmUpProject(godot);
  mkdirSync(MEDIA_DIR, { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });
  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });

  const raw = join(WORK_DIR, "raw.mp4");
  const display = await startVirtualDisplay(WIDTH, HEIGHT);
  console.log(`Display: ${display.display} at ${WIDTH}x${HEIGHT}`);

  // conduitEnv points at example-project; the demo runs against the copy, so
  // both the bridge and the broker have to derive their endpoint from that.
  const env = {
    ...conduitEnv(RUNTIME_DIR, { GDRUST_SUPPRESSED_WARNINGS: "EditorPlaceholderV06" }),
    CONDUIT_PROJECT: DEMO_PROJECT,
    DISPLAY: display.display,
  };

  console.log("Launching editor ...");
  const editor = Bun.spawn(
    godotCommand(
      godot,
      ["--editor", "--rendering-driver", "opengl3", "--resolution", `${WIDTH}x${HEIGHT}`, "--position", "0,0", "--path", DEMO_PROJECT],
      true,
      display.display,
    ),
    { cwd: repoRoot, env, stdout: "ignore", stderr: "ignore" },
  );

  const recorder = new Recorder({ display: display.display, width: WIDTH, height: HEIGHT, output: raw, workDir: WORK_DIR });
  let client: Client | null = null;
  try {
    await waitForEditor(RUNTIME_DIR, 180_000, DEMO_PROJECT);
    console.log("Editor bridge up; connecting the broker ...");
    // No opt-in flags: the whole demo runs on the default tool surface, which
    // is part of what it is demonstrating.
    const transport = new StdioClientTransport({
      command: "bun",
      args: [join(repoRoot, "broker", "src", "index.ts")],
      env,
    });
    client = new Client({ name: "conduit-demo", version: "0.3.0" });
    await client.connect(transport);
    // Let the editor settle: import scan, docks laid out, no startup toast.
    await sleep(8_000);

    console.log("Recording ...");
    await recorder.start();
    await new Scenario(client, recorder).run();
    const chapters = await recorder.stop();

    console.log(`Captured ${(await probeDuration(raw)).toFixed(1)} s over ${chapters.length} chapters`);
    for (const chapter of chapters) {
      console.log(`  ${chapter.start.toFixed(1).padStart(6)}s  ${chapter.title}`);
    }

    console.log("Encoding ...");
    await writeMp4(raw, join(MEDIA_DIR, "demo.mp4"));
    await writeGif(raw, join(MEDIA_DIR, "demo.gif"), chapters, WORK_DIR);
    console.log("Wrote docs/media/demo.mp4 and docs/media/demo.gif");
  } finally {
    recorder.kill();
    await client?.close().catch(() => {});
    killTree(editor);
    await editor.exited.catch(() => {});
    display.stop();
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
  }
}

async function buildBridge(): Promise<void> {
  console.log("Building bridge (cargo build -p conduit) ...");
  const code = await Bun.spawn(["cargo", "build", "-p", "conduit"], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
  if (code !== 0) {
    throw new Error("bridge build failed");
  }
}

/**
 * A headless pass over the project before the recorded one. Godot only writes
 * .godot/extension_list.cfg during its import scan, so a project opened for the
 * first time does not load the bridge until the *second* launch; the README
 * tells human users the same thing ("Open the project once"). Doing it headless
 * also keeps the import progress bar out of the recording.
 */
async function warmUpProject(godot: string): Promise<void> {
  console.log("Warming up the demo project (import scan and extension registration) ...");
  const proc = Bun.spawn([godot, "--headless", "--editor", "--quit-after", "600", "--path", DEMO_PROJECT], {
    cwd: repoRoot,
    env: { ...process.env, GDRUST_SUPPRESSED_WARNINGS: "EditorPlaceholderV06" } as Record<string, string>,
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

/** Refresh the throwaway project from the tracked example, keeping its .godot
 * import cache so repeat runs do not pay for a full reimport on camera. */
function materialiseDemoProject(): void {
  const cache = join(DEMO_PROJECT, ".godot");
  const keepCache = existsSync(cache);
  for (const entry of ["addons", "main.tscn", "player.gd", "project.godot", "conduit.gdextension"]) {
    rmSync(join(DEMO_PROJECT, entry), { recursive: true, force: true });
  }
  if (!keepCache) {
    rmSync(DEMO_PROJECT, { recursive: true, force: true });
  }
  mkdirSync(DEMO_PROJECT, { recursive: true });
  for (const entry of ["addons", "main.tscn", "player.gd", "project.godot", "conduit.gdextension"]) {
    cpSync(join(exampleProject, entry), join(DEMO_PROJECT, entry), { recursive: true });
  }
  // Artifacts an earlier take left behind; the scenario creates them again.
  for (const entry of ["level.tscn", "coin.gd", "level_tools.gd"]) {
    rmSync(join(DEMO_PROJECT, entry), { force: true });
  }
  console.log(`Demo project: ${DEMO_PROJECT}${keepCache ? " (reusing .godot cache)" : ""}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
