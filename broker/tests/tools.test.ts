import { describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { BridgeManager } from "../src/bridge-manager.ts";
import type { EventRing } from "../src/events.ts";
import { GodotResolver } from "../src/godot-locate.ts";
import { DEFAULT_TIMEOUTS } from "../src/tool-helpers.ts";
import { registerTools } from "../src/index.ts";

interface Registration {
  name: string;
  config: {
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  };
}

function collectRegistrations(): { server: McpServer; registrations: Registration[] } {
  const registrations: Registration[] = [];
  const server = {
    registerTool(name: string, config: Registration["config"]) {
      registrations.push({ name, config });
    },
  } as unknown as McpServer;
  return { server, registrations };
}

interface OptionOverrides {
  enablePixelTools?: boolean;
  enableEditorEval?: boolean;
  disableEval?: boolean;
}

function toolOptions(overrides: OptionOverrides = {}) {
  return {
    enablePixelTools: overrides.enablePixelTools ?? false,
    enableEditorEval: overrides.enableEditorEval ?? false,
    disableEval: overrides.disableEval ?? false,
    godot: new GodotResolver(null),
    projectPath: null,
    runtimeDir: "",
    addonSource: null,
    timeouts: DEFAULT_TIMEOUTS,
  };
}

const EXPECTED_TOOLS = [
  "gd_addon_install",
  "gd_addon_status",
  "gd_animation",
  "gd_asset_add",
  "gd_asset_reimport",
  "gd_audio",
  "gd_autoload",
  "gd_classdb",
  "gd_debug",
  "gd_editor_dialog_choose",
  "gd_editor_get_state",
  "gd_editor_inspect",
  "gd_editor_launch",
  "gd_editor_list_dialogs",
  "gd_editor_open_script",
  "gd_editor_plugin",
  "gd_editor_quit",
  "gd_editor_screenshot",
  "gd_editor_select",
  "gd_editor_set_main_screen",
  "gd_editor_ui",
  "gd_engine_install",
  "gd_engine_status",
  "gd_export_presets",
  "gd_export_project",
  "gd_file_delete",
  "gd_file_move",
  "gd_find_nodes",
  "gd_game_eval",
  "gd_game_list",
  "gd_get_errors",
  "gd_get_events",
  "gd_get_logs",
  "gd_http_request",
  "gd_import_settings",
  "gd_input",
  "gd_input_map",
  "gd_multiplayer",
  "gd_node_add",
  "gd_node_call",
  "gd_node_duplicate",
  "gd_node_get_info",
  "gd_node_get_property",
  "gd_node_group",
  "gd_node_remove",
  "gd_node_rename",
  "gd_node_reparent",
  "gd_node_set_property",
  "gd_object",
  "gd_pause",
  "gd_perf",
  "gd_physics",
  "gd_ping",
  "gd_play",
  "gd_project_get_setting",
  "gd_project_scaffold",
  "gd_project_set_setting",
  "gd_redo",
  "gd_render",
  "gd_resource_call",
  "gd_resource_create",
  "gd_resource_get_property",
  "gd_resource_set_property",
  "gd_scene_create",
  "gd_scene_find_nodes",
  "gd_scene_instantiate",
  "gd_scene_node_call",
  "gd_scene_node_get_property",
  "gd_scene_node_set_property",
  "gd_scene_object",
  "gd_scene_open",
  "gd_scene_save",
  "gd_scene_save_all",
  "gd_scene_signal",
  "gd_scene_tree_get",
  "gd_screenshot",
  "gd_script_attach",
  "gd_script_create",
  "gd_script_detach",
  "gd_script_validate",
  "gd_set_time_scale",
  "gd_shader_validate",
  "gd_signal",
  "gd_status",
  "gd_step_frames",
  "gd_stop",
  "gd_tilemap",
  "gd_translations",
  "gd_tree_get",
  "gd_tree_mutate",
  "gd_undo",
  "gd_wait_frames",
  "gd_wait_time",
  "gd_websocket",
  "gd_window",
];

describe("tool definitions", () => {
  const { server, registrations } = collectRegistrations();
  // The manager and events are only used inside handlers, not during registration.
  // Pixel tools are off by default, so the default surface excludes them.
  registerTools(server, {} as unknown as BridgeManager, {} as unknown as EventRing, toolOptions());

  test("registers exactly the phase 1-9 tool surface", () => {
    const names = registrations.map((r) => r.name).sort();
    expect(names).toEqual(EXPECTED_TOOLS);
  });

  // Phase 9 revisits the section 7.1 bound as its phase-8 form anticipated: the
  // budget is a design pressure, not a hard cap, and the phase-9 additions
  // (session lifecycle, preset listing, three consolidated networking tools)
  // land the static surface just above the old 75 ceiling. Dynamic
  // gd_project_* tools are deliberately outside this count; they exist only
  // while a game exposes them and scale with the project, not the broker.
  //
  // Phase 14's gd_shader_validate takes the last slot phase 9 left spare. The
  // ceiling is deliberately held at the exact current count rather than moved
  // to a round number with headroom: the point of the bound is that adding a
  // tool has to be argued for, and headroom is what lets that argument be
  // skipped.
  //
  // Phase 15 moves it to 93, and the argument is that these are the last two:
  // gd_editor_plugin and gd_translations close the final two items whitepaper
  // section 8 names and the surface lacked. The ceiling again lands on the
  // exact new count, so phase 16 has to make its own case rather than spend
  // headroom this phase left behind.
  //
  // Phase 16 makes that case and moves it to 95. gd_object and gd_scene_object
  // are the bookkeeping half of the last generic verb, and the cluster they
  // close is the largest single one left in the coverage matrix: 3732 members
  // across 295 Object-derived classes that no path, class name, or res:// path
  // can name. They are two rather than one because the handle table is per
  // bridge process, so a single tool would need a bridge argument that the
  // gd_node_call / gd_scene_node_call split already encodes in the name. The
  // ceiling again lands on the exact new count.
  test("the tool surface stays within the revised section 7.1 budget", () => {
    expect(registrations.length).toBeGreaterThanOrEqual(40);
    expect(registrations.length).toBeLessThanOrEqual(95);
  });

  test("every tool name is gd_-prefixed and unique", () => {
    const names = registrations.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.startsWith("gd_")).toBe(true);
    }
  });

  test("every tool declares a description and annotations", () => {
    for (const { config } of registrations) {
      expect(typeof config.description).toBe("string");
      expect((config.description ?? "").length).toBeGreaterThan(10);
      expect(config.annotations).toBeDefined();
    }
  });

  test("descriptions stay within a reasonable length bound", () => {
    for (const { config } of registrations) {
      expect((config.description ?? "").length).toBeLessThan(400);
    }
  });

  test("read tools are annotated read-only and non-destructive", () => {
    for (const name of ["gd_node_get_property", "gd_get_logs", "gd_perf", "gd_status"]) {
      const tool = registrations.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(true);
      expect(tool?.config.annotations?.destructiveHint).toBe(false);
    }
  });

  test("gd_game_eval is annotated destructive and open-world", () => {
    const evalTool = registrations.find((r) => r.name === "gd_game_eval");
    expect(evalTool?.config.annotations?.destructiveHint).toBe(true);
    expect(evalTool?.config.annotations?.openWorldHint).toBe(true);
  });

  test("gd_undo and gd_redo are mutating but not flagged destructive", () => {
    for (const name of ["gd_undo", "gd_redo"]) {
      const tool = registrations.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(false);
      expect(tool?.config.annotations?.destructiveHint).toBe(false);
      expect(tool?.config.annotations?.idempotentHint).toBe(false);
    }
  });

  test("gd_asset_add is annotated destructive and not idempotent", () => {
    const tool = registrations.find((r) => r.name === "gd_asset_add");
    expect(tool?.config.annotations?.destructiveHint).toBe(true);
    expect(tool?.config.annotations?.idempotentHint).toBe(false);
  });

  test("gd_editor_get_state and the validators are read-only and non-destructive", () => {
    for (const name of ["gd_editor_get_state", "gd_script_validate", "gd_shader_validate"]) {
      const tool = registrations.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(true);
      expect(tool?.config.annotations?.destructiveHint).toBe(false);
    }
  });

  test("gd_export_project is annotated destructive, idempotent, and not read-only", () => {
    const tool = registrations.find((r) => r.name === "gd_export_project");
    expect(tool?.config.annotations?.readOnlyHint).toBe(false);
    expect(tool?.config.annotations?.destructiveHint).toBe(true);
    expect(tool?.config.annotations?.idempotentHint).toBe(true);
    expect(tool?.config.annotations?.openWorldHint).toBe(false);
  });

  test("read-only editor tools are annotated read-only and non-destructive", () => {
    for (const name of ["gd_editor_list_dialogs", "gd_editor_screenshot"]) {
      const tool = registrations.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(true);
      expect(tool?.config.annotations?.destructiveHint).toBe(false);
    }
  });

  test("dialog and tier-2 UI tools are annotated destructive", () => {
    for (const name of ["gd_editor_dialog_choose", "gd_editor_ui"]) {
      const tool = registrations.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(false);
      expect(tool?.config.annotations?.destructiveHint).toBe(true);
    }
  });

  test("gd_debug is neither read-only nor destructive", () => {
    const tool = registrations.find((r) => r.name === "gd_debug");
    expect(tool?.config.annotations?.readOnlyHint).toBe(false);
    expect(tool?.config.annotations?.destructiveHint).toBe(false);
  });

  test("phase 7 query and introspection tools are read-only and non-destructive", () => {
    for (const name of ["gd_classdb", "gd_find_nodes", "gd_scene_find_nodes", "gd_scene_node_get_property"]) {
      const tool = registrations.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(true);
      expect(tool?.config.annotations?.destructiveHint).toBe(false);
    }
  });

  test("phase 7 mutating tools are annotated destructive", () => {
    for (const name of [
      "gd_scene_node_set_property",
      "gd_scene_instantiate",
      "gd_scene_signal",
      "gd_node_group",
      "gd_autoload",
      "gd_input_map",
    ]) {
      const tool = registrations.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(false);
      expect(tool?.config.annotations?.destructiveHint).toBe(true);
    }
  });

  // Both carry a read-only list op, but both also write project.godot, and an
  // annotation describes the tool rather than its cheapest op.
  test("phase 15 project tools are annotated destructive and not open-world", () => {
    for (const name of ["gd_editor_plugin", "gd_translations"]) {
      const tool = registrations.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(false);
      expect(tool?.config.annotations?.destructiveHint).toBe(true);
      expect(tool?.config.annotations?.openWorldHint).toBe(false);
    }
  });

  // gd_physics carries mutating ops (world_set, nav_bake), so none of the
  // phase 8 tools can truthfully claim read-only.
  test("phase 8 runtime tools are annotated destructive and not open-world", () => {
    for (const name of [
      "gd_animation",
      "gd_physics",
      "gd_render",
      "gd_audio",
      "gd_tilemap",
      "gd_window",
      "gd_tree_mutate",
    ]) {
      const tool = registrations.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(false);
      expect(tool?.config.annotations?.destructiveHint).toBe(true);
      expect(tool?.config.annotations?.openWorldHint).toBe(false);
    }
  });

  test("phase 8 tools route to the game bridge with the shared instance field", () => {
    for (const name of ["gd_animation", "gd_physics", "gd_tilemap", "gd_tree_mutate"]) {
      const tool = registrations.find((r) => r.name === name);
      expect(tool?.config.inputSchema?.instance).toBeDefined();
    }
  });
});

const PIXEL_TOOLS = [
  "gd_editor_pixel_click",
  "gd_editor_pixel_drag",
  "gd_editor_pixel_move",
  "gd_editor_window_info",
];

function registrationsWith(options: OptionOverrides): Registration[] {
  const { server, registrations } = collectRegistrations();
  registerTools(server, {} as unknown as BridgeManager, {} as unknown as EventRing, toolOptions(options));
  return registrations;
}

describe("tier-3 pixel tool gating", () => {
  test("pixel tools are absent from the default tool surface", () => {
    const names = registrationsWith({}).map((r) => r.name);
    for (const name of PIXEL_TOOLS) {
      expect(names).not.toContain(name);
    }
  });

  test("pixel tools are registered only when explicitly enabled", () => {
    const names = registrationsWith({ enablePixelTools: true }).map((r) => r.name).sort();
    for (const name of PIXEL_TOOLS) {
      expect(names).toContain(name);
    }
  });

  test("enabling pixel tools adds exactly the four tier-3 tools", () => {
    const off = new Set(registrationsWith({}).map((r) => r.name));
    const added = registrationsWith({ enablePixelTools: true })
      .map((r) => r.name)
      .filter((name) => !off.has(name))
      .sort();
    expect(added).toEqual(PIXEL_TOOLS);
  });

  test("pixel input tools are destructive and not idempotent; window_info is read-only", () => {
    const enabled = registrationsWith({ enablePixelTools: true });
    for (const name of ["gd_editor_pixel_move", "gd_editor_pixel_click", "gd_editor_pixel_drag"]) {
      const tool = enabled.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(false);
      expect(tool?.config.annotations?.destructiveHint).toBe(true);
      expect(tool?.config.annotations?.idempotentHint).toBe(false);
      expect(tool?.config.annotations?.openWorldHint).toBe(false);
    }
    const info = enabled.find((r) => r.name === "gd_editor_window_info");
    expect(info?.config.annotations?.readOnlyHint).toBe(true);
    expect(info?.config.annotations?.destructiveHint).toBe(false);
  });
});

describe("editor eval gating", () => {
  test("gd_editor_eval is absent from the default tool surface", () => {
    const names = registrationsWith({}).map((r) => r.name);
    expect(names).not.toContain("gd_editor_eval");
  });

  test("enabling editor eval adds exactly one tool", () => {
    const off = new Set(registrationsWith({}).map((r) => r.name));
    const added = registrationsWith({ enableEditorEval: true })
      .map((r) => r.name)
      .filter((name) => !off.has(name));
    expect(added).toEqual(["gd_editor_eval"]);
  });

  test("gd_editor_eval is annotated destructive and open-world, like gd_game_eval", () => {
    const tool = registrationsWith({ enableEditorEval: true }).find((r) => r.name === "gd_editor_eval");
    expect(tool?.config.annotations?.readOnlyHint).toBe(false);
    expect(tool?.config.annotations?.destructiveHint).toBe(true);
    expect(tool?.config.annotations?.openWorldHint).toBe(true);
  });
});

// Eval-class gating (section 9): --disable-eval drops arbitrary evaluation and
// everything with equivalent authority together. Dynamic gd_project_* tools are
// gated in main() (the registry is never constructed), not in registerTools.
const EVAL_CLASS_TOOLS = ["gd_game_eval", "gd_http_request", "gd_multiplayer", "gd_websocket"];

describe("disable-eval gating", () => {
  test("disabling eval removes exactly the eval-class static tools", () => {
    const on = registrationsWith({}).map((r) => r.name);
    const off = new Set(registrationsWith({ disableEval: true }).map((r) => r.name));
    const removed = on.filter((name) => !off.has(name)).sort();
    expect(removed).toEqual(EVAL_CLASS_TOOLS);
  });

  test("disable-eval wins over enable-editor-eval", () => {
    const names = registrationsWith({ disableEval: true, enableEditorEval: true }).map((r) => r.name);
    expect(names).not.toContain("gd_editor_eval");
    expect(names).not.toContain("gd_game_eval");
  });

  test("session tools stay available under disable-eval", () => {
    const names = registrationsWith({ disableEval: true }).map((r) => r.name);
    for (const name of ["gd_project_scaffold", "gd_editor_launch", "gd_editor_quit", "gd_export_presets"]) {
      expect(names).toContain(name);
    }
  });

  test("networking tools are annotated destructive and open-world", () => {
    const all = registrationsWith({});
    for (const name of ["gd_http_request", "gd_websocket", "gd_multiplayer"]) {
      const tool = all.find((r) => r.name === name);
      expect(tool?.config.annotations?.destructiveHint).toBe(true);
      expect(tool?.config.annotations?.openWorldHint).toBe(true);
    }
  });
});
