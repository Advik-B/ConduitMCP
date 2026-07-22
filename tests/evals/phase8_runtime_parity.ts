#!/usr/bin/env bun
// Phase 8 live acceptance runner (whitepaper section 10). Runtime systems
// parity: matrix and transform Variant round-trips, animation control and
// authoring, physics and navigation queries, rendering and environment,
// audio buses, TileMap and GridMap cells, window and system info, touch and
// gamepad input, and runtime scene mutation.
//
// Everything is game-bridge work, so the whole run talks the raw bridge
// protocol to one bare headless game launched straight into the phase8
// fixture scene (the phase 4/7 part-B pattern; gd_play from a headless
// editor is unproven and the broker only adopts games it launches itself).
// The game's stderr is captured to a log so a dynamic-call panic is
// diagnosable rather than silent.
//
// Run with `bun tests/evals/phase8_runtime_parity.ts` (needs GODOT_BIN).

import { mkdirSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { BridgeClient } from "../../broker/src/ipc-client.ts";
import {
  conduitEnv,
  godotCommand,
  killTree,
  repoRoot,
  resolveGodot,
  runtimeDir,
  waitForGameEndpoint,
} from "./harness.ts";

const GAME_RUNTIME_DIR = runtimeDir("p8game");
const GAME_STDERR_LOG = join(GAME_RUNTIME_DIR, "game-stderr.log");

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

function approx(a: unknown, b: number, eps = 0.001): boolean {
  return typeof a === "number" && Math.abs(a - b) <= eps;
}

let bridge: BridgeClient;

async function call(tool: string, args: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<any> {
  return bridge.request(tool, args, timeoutMs);
}

async function waitFrames(frames: number): Promise<void> {
  await call("gd_wait_frames", { frames }, 30_000);
}

async function main(): Promise<void> {
  const godot = resolveGodot();
  console.log(`Godot: ${godot}`);
  console.log(`Runtime dir: ${GAME_RUNTIME_DIR}`);

  console.log("\nBuilding bridge (cargo build -p conduit) ...");
  if ((await run(["cargo", "build", "-p", "conduit"], repoRoot)) !== 0) {
    throw new Error("bridge build failed");
  }

  rmSync(GAME_RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(GAME_RUNTIME_DIR, { recursive: true });

  console.log("\nLaunching a bare headless game on the phase8 fixture scene ...");
  const stderrFd = openSync(GAME_STDERR_LOG, "w");
  const game = Bun.spawn(
    godotCommand(godot, ["--headless", "--path", "example-project", "res://phase8.tscn"], false),
    {
      cwd: repoRoot,
      env: conduitEnv(GAME_RUNTIME_DIR),
      stdout: "ignore",
      stderr: stderrFd,
    },
  );

  try {
    const endpoint = await waitForGameEndpoint(GAME_RUNTIME_DIR, 60_000);
    if (!endpoint) {
      throw new Error("game bridge endpoint never appeared");
    }
    bridge = new BridgeClient({ endpoint, defaultTimeoutMs: 10_000 });
    await bridge.connect();
    await bridge.waitForHello(10_000);
    record("game_bound", true, "game bridge answered hello");

    await runVariantChecks();
    await runAnimationChecks();
    await runPhysicsChecks();
    await runTileChecks();
    await runRenderChecks();
    await runAudioChecks();
    await runInputChecks();
    await runWindowChecks();
    await runTreeMutateChecks();
    await runChangeSceneCheck();
  } finally {
    bridge?.close();
    killTree(game);
    await game.exited.catch(() => {});
    closeSync(stderrFd);
    reportGameStderr();
    rmSync(GAME_RUNTIME_DIR, { recursive: true, force: true });
  }

  console.log("\n=== Phase 8 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 8 checks passed.");
}

function reportGameStderr(): void {
  try {
    const text = readFileSync(GAME_STDERR_LOG, "utf8").trim();
    if (text.length > 0) {
      console.log("\n--- game stderr (tail) ---");
      console.log(text.split("\n").slice(-40).join("\n"));
    }
  } catch {
    // Log already removed or never written.
  }
}

async function runVariantChecks(): Promise<void> {
  console.log("\nMatrix and transform Variant round-trips ...");
  await call("gd_node_set_property", {
    node_path: "/root/Phase8/Target",
    property: "transform",
    value: {
      __type: "Transform2D",
      x: [0, 1],
      y: [-1, 0],
      origin: { x: 5, y: 7 },
    },
  });
  const t2d = (await call("gd_node_get_property", { node_path: "/root/Phase8/Target", property: "transform" })).value;
  record(
    "variant_transform2d_roundtrip",
    t2d?.__type === "Transform2D" &&
      approx(t2d.x?.x, 0) && approx(t2d.x?.y, 1) &&
      approx(t2d.y?.x, -1) && approx(t2d.y?.y, 0) &&
      approx(t2d.origin?.x, 5) && approx(t2d.origin?.y, 7),
    `transform reads back ${JSON.stringify(t2d)}`,
  );

  await call("gd_node_set_property", {
    node_path: "/root/Phase8/World3D/Target3D",
    property: "transform",
    value: {
      __type: "Transform3D",
      basis: { x: [0, 2, 0], y: [-2, 0, 0], z: [0, 0, 3] },
      origin: [1, 2, 3],
    },
  });
  const t3d = (await call("gd_node_get_property", { node_path: "/root/Phase8/World3D/Target3D", property: "transform" }))
    .value;
  record(
    "variant_transform3d_basis_columns",
    t3d?.__type === "Transform3D" &&
      approx(t3d.basis?.x?.y, 2) && approx(t3d.basis?.y?.x, -2) && approx(t3d.basis?.z?.z, 3) &&
      approx(t3d.origin?.x, 1) && approx(t3d.origin?.z, 3),
    `column mapping survives the live engine: ${JSON.stringify(t3d?.basis)}`,
  );

  const aabb = { __type: "AABB", position: { x: 1, y: 2, z: 3 }, size: { x: 4, y: 5, z: 6 } };
  const plane = { __type: "Plane", normal: { x: 0, y: 1, z: 0 }, d: 2.5 };
  const projection = {
    __type: "Projection",
    x: [1, 0, 0, 0],
    y: [0, 2, 0, 0],
    z: [0, 0, 3, 0],
    w: [0, 0, 0, 4],
  };
  const echoAabb = (await call("gd_node_call", { node_path: "/root/Phase8", method: "echo", args: [aabb] })).result;
  const echoPlane = (await call("gd_node_call", { node_path: "/root/Phase8", method: "echo", args: [plane] })).result;
  const echoProjection = (await call("gd_node_call", { node_path: "/root/Phase8", method: "echo", args: [projection] }))
    .result;
  record(
    "variant_echo_aabb_plane_projection",
    echoAabb?.__type === "AABB" && approx(echoAabb.position?.x, 1) && approx(echoAabb.size?.z, 6) &&
      echoPlane?.__type === "Plane" && approx(echoPlane.normal?.y, 1) && approx(echoPlane.d, 2.5) &&
      echoProjection?.__type === "Projection" && approx(echoProjection.y?.y, 2) && approx(echoProjection.w?.w, 4),
    "AABB, Plane, and Projection echo through both conversion directions",
  );
}

async function runAnimationChecks(): Promise<void> {
  console.log("\nAnimation: play, progress, seek, create, bones, state machine ...");
  const played = await call("gd_animation", { op: "play", node_path: "/root/Phase8/Anim", name: "pulse" });
  await waitFrames(3);
  const state = await call("gd_animation", { op: "state", node_path: "/root/Phase8/Anim" });
  record(
    "animation_play_and_progress",
    played.current_animation === "pulse" && state.playing === true && state.current_animation === "pulse" &&
      typeof state.position === "number" && state.position > 0,
    `playing=${state.playing}, position=${state.position}, length=${state.length}`,
  );

  const sought = await call("gd_animation", { op: "seek", node_path: "/root/Phase8/Anim", seconds: 0.25 });
  record(
    "animation_seek",
    typeof sought.position === "number" && sought.position >= 0.2 && sought.position <= 0.3,
    `after seek 0.25 position=${sought.position}`,
  );
  await call("gd_animation", { op: "stop", node_path: "/root/Phase8/Anim" });

  const created = await call("gd_animation", {
    op: "create",
    node_path: "/root/Phase8/Anim",
    name: "p8gen",
    length: 0.4,
    tracks: [
      { path: "Target:rotation", keys: [{ time: 0.0, value: 0.0 }, { time: 0.4, value: 1.5 }] },
    ],
  });
  const list = await call("gd_animation", { op: "list", node_path: "/root/Phase8/Anim" });
  await call("gd_animation", { op: "play", node_path: "/root/Phase8/Anim", name: "p8gen" });
  const genState = await call("gd_animation", { op: "state", node_path: "/root/Phase8/Anim" });
  record(
    "animation_create_and_play",
    created.created === "p8gen" && list.animations?.includes("p8gen") && genState.current_animation === "p8gen",
    `created and playing generated animation, list=${JSON.stringify(list.animations)}`,
  );
  await call("gd_animation", { op: "stop", node_path: "/root/Phase8/Anim" });

  const tweened = await call("gd_animation", {
    op: "tween",
    node_path: "/root/Phase8/Target",
    property: "modulate",
    to: { __type: "Color", r: 1, g: 0, b: 0, a: 1 },
    duration: 0.2,
    trans: "sine",
    ease: "out",
  });
  await waitFrames(40);
  const modulate = (await call("gd_node_get_property", { node_path: "/root/Phase8/Target", property: "modulate" })).value;
  record(
    "animation_tween_property",
    tweened.tweening === true && approx(modulate?.g, 0, 0.1),
    `modulate tweened from white toward red: ${JSON.stringify(modulate)}`,
  );

  const boneSet = await call("gd_animation", {
    op: "bone_set",
    node_path: "/root/Phase8/World3D/Bones",
    bone: "root_bone",
    position: [1, 2, 3],
  });
  const boneGet = await call("gd_animation", {
    op: "bone_get",
    node_path: "/root/Phase8/World3D/Bones",
    bone: 0,
  });
  record(
    "animation_bone_pose",
    boneSet.name === "root_bone" && approx(boneGet.position?.x, 1) && approx(boneGet.position?.z, 3),
    `bone pose reads back ${JSON.stringify(boneGet.position)}`,
  );

  await call("gd_node_set_property", { node_path: "/root/Phase8/Tree", property: "active", value: true });
  await call("gd_animation", { op: "tree", node_path: "/root/Phase8/Tree", action: "travel", to: "pulse" });
  await waitFrames(3);
  const treeState = await call("gd_animation", { op: "tree", node_path: "/root/Phase8/Tree", action: "state" });
  record(
    "animation_tree_travel",
    treeState.current_node === "pulse" && treeState.active === true,
    `state machine at '${treeState.current_node}', active=${treeState.active}`,
  );
  await call("gd_node_set_property", { node_path: "/root/Phase8/Tree", property: "active", value: false });
}

async function runPhysicsChecks(): Promise<void> {
  console.log("\nPhysics: raycasts, shape query, gravity, navigation ...");
  // Colliders register with the physics space on the first physics frame.
  await waitFrames(3);

  const ray2d = await call("gd_physics", { op: "raycast", dimension: "2d", from: [0, 0], to: [0, 200] });
  record(
    "physics_raycast_2d",
    ray2d.hit === true && String(ray2d.collider_path).endsWith("Body2D") &&
      ray2d.position?.y > 60 && ray2d.position?.y < 76,
    `hit=${ray2d.hit} at ${JSON.stringify(ray2d.position)} on ${ray2d.collider_path}`,
  );

  const ray3d = await call("gd_physics", { op: "raycast", dimension: "3d", from: [0, 5, 0], to: [0, -5, 0] });
  record(
    "physics_raycast_3d",
    ray3d.hit === true && String(ray3d.collider_path).endsWith("Body3D") && approx(ray3d.position?.y, 1, 0.05),
    `hit=${ray3d.hit} at ${JSON.stringify(ray3d.position)} on ${ray3d.collider_path}`,
  );

  const shapeHits = await call("gd_physics", {
    op: "intersect_shape",
    dimension: "2d",
    shape: { kind: "circle", radius: 20 },
    position: [0, 100],
  });
  record(
    "physics_intersect_shape_2d",
    shapeHits.count >= 1 && (shapeHits.hits ?? []).some((h: any) => String(h.collider_path).endsWith("Body2D")),
    `${shapeHits.count} hit(s) for a circle at the collider`,
  );

  const world = await call("gd_physics", { op: "world_get", dimension: "2d" });
  const defaultGravity = world.gravity;
  record(
    "physics_world_gravity_read",
    approx(defaultGravity, 980, 1),
    `2d default gravity reads ${defaultGravity} (space RID as default area)`,
  );
  const worldSet = await call("gd_physics", { op: "world_set", dimension: "2d", gravity: 500 });
  record("physics_world_gravity_set", approx(worldSet.gravity, 500, 0.01), `gravity set to ${worldSet.gravity}`);
  await call("gd_physics", { op: "world_set", dimension: "2d", gravity: defaultGravity });

  const emptyPath = await call("gd_physics", { op: "nav_path", dimension: "2d", from: [0, 0], to: [50, 50] });
  record(
    "physics_nav_path_unbaked",
    Array.isArray(emptyPath.points) && emptyPath.count === 0,
    `unbaked map returns an empty path without error`,
  );

  const baked = await call("gd_physics", { op: "nav_bake", dimension: "2d", node_path: "/root/Phase8/NavRegion" });
  await waitFrames(10);
  const path = await call("gd_physics", { op: "nav_path", dimension: "2d", from: [10, 10], to: [90, 90] });
  record(
    "physics_nav_bake_then_path",
    baked.requested === true && path.count >= 2,
    `baked and pathed with ${path.count} points`,
  );
}

async function runTileChecks(): Promise<void> {
  console.log("\nTileMapLayer and GridMap cells ...");
  const setCell = await call("gd_tilemap", {
    op: "set_cell",
    node_path: "/root/Phase8/Tiles",
    coords: [2, 3],
    source_id: 0,
  });
  const getCell = await call("gd_tilemap", { op: "get_cell", node_path: "/root/Phase8/Tiles", coords: [2, 3] });
  const used = await call("gd_tilemap", { op: "used_cells", node_path: "/root/Phase8/Tiles", limit: 8 });
  record(
    "tilemap_cell_roundtrip",
    setCell.empty === false && getCell.source_id === 0 && getCell.empty === false &&
      used.total_count === 1 && used.items?.[0]?.coords?.x === 2,
    `cell (2,3) set and read back, used_cells total=${used.total_count}`,
  );

  const rect = await call("gd_tilemap", { op: "used_rect", node_path: "/root/Phase8/Tiles" });
  await call("gd_tilemap", { op: "erase_cell", node_path: "/root/Phase8/Tiles", coords: [2, 3] });
  const afterErase = await call("gd_tilemap", { op: "get_cell", node_path: "/root/Phase8/Tiles", coords: [2, 3] });
  record(
    "tilemap_used_rect_and_erase",
    rect.rect?.__type === "Rect2i" && afterErase.empty === true,
    `used_rect=${JSON.stringify(rect.rect)}, erased cell is empty`,
  );

  const gridSet = await call("gd_tilemap", {
    op: "set_cell",
    node_path: "/root/Phase8/World3D/Grid",
    coords: [1, 0, 2],
    item: 0,
  });
  const gridGet = await call("gd_tilemap", {
    op: "get_cell",
    node_path: "/root/Phase8/World3D/Grid",
    coords: { x: 1, y: 0, z: 2 },
  });
  const gridUsed = await call("gd_tilemap", { op: "used_cells", node_path: "/root/Phase8/World3D/Grid" });
  record(
    "gridmap_cell_roundtrip",
    gridSet.item === 0 && gridGet.item === 0 && gridGet.empty === false && gridUsed.total_count === 1,
    `grid cell (1,0,2) item=${gridGet.item}, used=${gridUsed.total_count}`,
  );
  await call("gd_tilemap", { op: "erase_cell", node_path: "/root/Phase8/World3D/Grid", coords: [1, 0, 2] });
}

async function runRenderChecks(): Promise<void> {
  console.log("\nRendering: cameras, viewport settings, debug draw ...");
  const cam2d = await call("gd_render", { op: "camera_get", dimension: "2d" });
  const cam2dSet = await call("gd_render", {
    op: "camera_set",
    dimension: "2d",
    properties: { zoom: [2, 2] },
  });
  record(
    "render_camera_2d_adjust",
    String(cam2d.path).endsWith("Cam") && approx(cam2dSet.zoom?.x, 2) && approx(cam2dSet.zoom?.y, 2),
    `camera at ${cam2d.path}, zoom now ${JSON.stringify(cam2dSet.zoom)}`,
  );

  const cam3d = await call("gd_render", { op: "camera_get", dimension: "3d" });
  const cam3dSet = await call("gd_render", {
    op: "camera_set",
    dimension: "3d",
    properties: { fov: 50 },
  });
  record(
    "render_camera_3d_adjust",
    String(cam3d.path).endsWith("Cam3D") && cam3d.current === true && approx(cam3dSet.fov, 50),
    `camera at ${cam3d.path}, fov now ${cam3dSet.fov}`,
  );

  await call("gd_render", { op: "viewport_set", properties: { msaa_2d: 1 } });
  const viewport = await call("gd_render", { op: "viewport_get" });
  record(
    "render_viewport_settings_persist",
    viewport.msaa_2d === 1,
    `msaa_2d persists as ${viewport.msaa_2d} headless`,
  );
  await call("gd_render", { op: "viewport_set", properties: { msaa_2d: 0 } });

  const line = await call("gd_render", {
    op: "debug_draw",
    dimension: "2d",
    kind: "line",
    from: [0, 0],
    to: [50, 50],
    color: { r: 1, g: 0, b: 0 },
  });
  const sphere = await call("gd_render", {
    op: "debug_draw",
    dimension: "3d",
    kind: "sphere",
    center: [0, 0, 0],
    radius: 1,
  });
  const box = await call("gd_render", {
    op: "debug_draw",
    dimension: "3d",
    kind: "box",
    center: [0, 1, 0],
    size: [2, 2, 2],
  });
  const cleared = await call("gd_render", { op: "debug_clear" });
  record(
    "render_debug_draw",
    line.count === 1 && sphere.count === 1 && box.count === 2 && cleared.cleared === true,
    "line, sphere, and box primitives tracked and cleared (pixels are rendering-exempt)",
  );
}

async function runAudioChecks(): Promise<void> {
  console.log("\nAudio buses ...");
  const list = await call("gd_audio", { op: "bus_list" });
  const fx = (list.buses ?? []).find((b: any) => b.name === "Phase8Fx");
  record(
    "audio_bus_list",
    list.count >= 2 && fx !== undefined && approx(fx.volume_db, -3, 0.01),
    `${list.count} buses, Phase8Fx at ${fx?.volume_db} dB`,
  );

  const setBus = await call("gd_audio", { op: "bus_set", bus: "Phase8Fx", volume_db: -9, mute: true });
  record(
    "audio_bus_adjust",
    approx(setBus.volume_db, -9, 0.01) && setBus.mute === true,
    `Phase8Fx now ${setBus.volume_db} dB, mute=${setBus.mute}`,
  );
  await call("gd_audio", { op: "bus_set", bus: "Phase8Fx", volume_db: -3, mute: false });

  const added = await call("gd_audio", { op: "bus_add", name: "P8Temp" });
  const withEffect = await call("gd_audio", {
    op: "bus_effect",
    action: "add",
    bus: "P8Temp",
    effect_class: "AudioEffectAmplify",
  });
  const removed = await call("gd_audio", { op: "bus_remove", bus: "P8Temp" });
  record(
    "audio_bus_lifecycle_and_effects",
    added.name === "P8Temp" && withEffect.effects?.length === 1 &&
      withEffect.effects[0].class === "AudioEffectAmplify" && typeof removed.count === "number",
    `bus added, AudioEffectAmplify attached, bus removed (count=${removed.count})`,
  );

  const speaker = await call("gd_audio", { op: "player", action: "play", node_path: "/root/Phase8/Speaker" });
  const speakerState = await call("gd_audio", { op: "player", action: "state", node_path: "/root/Phase8/Speaker" });
  await call("gd_audio", { op: "player", action: "stop", node_path: "/root/Phase8/Speaker" });
  record(
    "audio_player_transport",
    speaker.playing === true && typeof speakerState.position === "number",
    `player playing=${speaker.playing}, position=${speakerState.position} (dummy driver may not advance)`,
  );
}

async function runInputChecks(): Promise<void> {
  console.log("\nGamepad, touch, and gesture input ...");
  await call("gd_input", { device: "joy_motion", axis: "left_x", value: 1.0 });
  await waitFrames(2);
  const strength1 = (await call("gd_game_eval", { source: 'return Input.get_action_strength("phase8_axis")' }, 30_000))
    .value;
  await waitFrames(3);
  const strength2 = (await call("gd_game_eval", { source: 'return Input.get_action_strength("phase8_axis")' }, 30_000))
    .value;
  await call("gd_input", { device: "joy_motion", axis: "left_x", value: 0.0 });
  await waitFrames(2);
  const strength3 = (await call("gd_game_eval", { source: 'return Input.get_action_strength("phase8_axis")' }, 30_000))
    .value;
  record(
    "input_gamepad_axis_hold",
    approx(strength1, 1) && approx(strength2, 1) && approx(strength3, 0),
    `action strength held at ${strength1}/${strength2} across frames, released to ${strength3}`,
  );

  const pressA = await call("gd_input", { device: "joy_button", button: "a" });
  const releaseA = await call("gd_input", { device: "joy_button", button: "a", pressed: false });
  record(
    "input_joy_button",
    pressA.injected === true && releaseA.injected === true && pressA.button === 0,
    "joypad button A press and release injected",
  );

  await call("gd_input", { device: "touch", position: [10, 10] });
  await call("gd_input", { device: "touch_drag", position: [40, 50], relative: [30, 40] });
  await call("gd_input", { device: "touch", position: [40, 50], pressed: false });
  await waitFrames(2);
  const lastTouch = (await call("gd_node_get_property", { node_path: "/root/Phase8", property: "last_touch" })).value;
  const touchActive = (await call("gd_node_get_property", { node_path: "/root/Phase8", property: "touch_active" }))
    .value;
  record(
    "input_touch_sequence",
    approx(lastTouch?.x, 40) && approx(lastTouch?.y, 50) && touchActive === false,
    `fixture saw the drag end at ${JSON.stringify(lastTouch)}, touch released`,
  );

  await call("gd_input", { device: "magnify", factor: 1.5, position: [100, 100] });
  await waitFrames(2);
  const gesture = (await call("gd_node_get_property", { node_path: "/root/Phase8", property: "last_gesture" })).value;
  const gestureValue = (await call("gd_node_get_property", { node_path: "/root/Phase8", property: "gesture_value" }))
    .value;
  record(
    "input_magnify_gesture",
    gesture === "magnify" && approx(gestureValue, 1.5),
    `fixture saw ${gesture} with factor ${gestureValue}`,
  );
}

async function runWindowChecks(): Promise<void> {
  console.log("\nWindow and system info ...");
  const info = await call("gd_window", { op: "get_info" });
  record(
    "window_headless_info",
    info.headless === true && info.display_server === "headless" && typeof info.size?.x === "number",
    `display=${info.display_server}, size=${JSON.stringify(info.size)}`,
  );

  const afterSet = await call("gd_window", { op: "set", title: "phase8" });
  record(
    "window_set_tolerated_headless",
    typeof afterSet.title === "string",
    `set accepted; title reads '${afterSet.title}' (headless no-op is documented)`,
  );

  const os = await call("gd_window", { op: "os_info" });
  const locale = await call("gd_window", { op: "locale_get" });
  record(
    "window_os_and_locale",
    typeof os.os === "string" && os.os.length > 0 && typeof locale.locale === "string" && locale.locale.length > 0,
    `os=${os.os}, processors=${os.processor_count}, locale=${locale.locale}`,
  );

  const setLocale = await call("gd_window", { op: "locale_set", locale: "fr" });
  record("window_locale_set", setLocale.locale?.startsWith("fr"), `locale now ${setLocale.locale}`);
  await call("gd_window", { op: "locale_set", locale: locale.locale });
}

async function runTreeMutateChecks(): Promise<void> {
  console.log("\nRuntime scene mutation: instantiate, add_node, reparent, free ...");
  const spawned = await call("gd_tree_mutate", {
    op: "instantiate",
    scene_path: "res://phase8_spawnling.tscn",
    parent_path: "/root/Phase8",
  });
  const found = await call("gd_find_nodes", { name_pattern: "Spawnling*" });
  record(
    "tree_instantiate",
    spawned.node_path === "/root/Phase8/Spawnling" && found.items?.length === 1,
    `instantiated at ${spawned.node_path}`,
  );

  const light = await call("gd_tree_mutate", {
    op: "add_node",
    class: "PointLight2D",
    parent_path: "/root/Phase8",
    name: "P8Light",
    properties: { energy: 2.0 },
  });
  const energy = (await call("gd_node_get_property", { node_path: "/root/Phase8/P8Light", property: "energy" })).value;
  record(
    "tree_add_node_with_properties",
    light.class === "PointLight2D" && approx(energy, 2),
    `raw node created at ${light.node_path} with energy=${energy}`,
  );
  await call("gd_tree_mutate", { op: "free", node_path: "/root/Phase8/P8Light" });

  const moved = await call("gd_tree_mutate", {
    op: "reparent",
    node_path: "/root/Phase8/Spawnling",
    new_parent_path: "/root/Phase8/World3D",
  });
  record(
    "tree_reparent",
    moved.node_path === "/root/Phase8/World3D/Spawnling",
    `now at ${moved.node_path}`,
  );

  const freed = await call("gd_tree_mutate", { op: "free", node_path: "/root/Phase8/World3D/Spawnling" });
  await waitFrames(2);
  const foundAfter = await call("gd_find_nodes", { name_pattern: "Spawnling*" });
  record(
    "tree_free",
    freed.queued === true && (foundAfter.items ?? []).length === 0,
    "freed node is gone after the frame settles",
  );
}

async function runChangeSceneCheck(): Promise<void> {
  console.log("\nChanging the current scene (last, by design) ...");
  const changed = await call("gd_tree_mutate", { op: "change_scene", scene_path: "res://phase8.tscn" });
  await waitFrames(5);
  const found = await call("gd_find_nodes", { name_pattern: "Phase8" });
  record(
    "tree_change_scene",
    changed.requested === true && found.items?.length === 1,
    "scene reloaded and the tree still answers",
  );
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
