// gd_audio: AudioServer bus control and stream player transport (whitepaper
// section 8 "Audio", phase 8). Spatial audio configuration is plain node
// properties on the positional players.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { type Timeouts, makeGameTool } from "../tool-helpers.ts";

export function registerGameAudioTools(server: McpServer, manager: BridgeManager, timeouts?: Timeouts): void {
  const gameTool = makeGameTool(server, manager, timeouts);

  gameTool(
    "gd_audio",
    "Audio control selected by op: bus_list, bus_set (volume_db, mute, solo, bypass, send), bus_add, bus_remove, bus_effect (action: add, remove, set_enabled with an AudioEffect class), and player (action: play, stop, pause, resume, state on any AudioStreamPlayer). Bus state stays readable and writable headless under the dummy driver.",
    {
      op: z
        .enum(["bus_list", "bus_set", "bus_add", "bus_remove", "bus_effect", "player"])
        .describe("Which audio operation to perform."),
      bus: z.union([z.string(), z.number()]).describe("Bus name or index (bus_set, bus_remove, bus_effect).").optional(),
      name: z.string().describe("New bus name (bus_add).").optional(),
      volume_db: z.number().describe("Bus volume in dB (bus_set).").optional(),
      mute: z.boolean().describe("Mute the bus (bus_set).").optional(),
      solo: z.boolean().describe("Solo the bus (bus_set).").optional(),
      bypass: z.boolean().describe("Bypass the bus effects (bus_set).").optional(),
      send: z.string().describe("Send target bus name (bus_set).").optional(),
      action: z.string().describe("Sub-action: add, remove, set_enabled (bus_effect); play, stop, pause, resume, state (player).").optional(),
      effect_class: z.string().describe("AudioEffect class to add, for example AudioEffectReverb (bus_effect add).").optional(),
      effect_index: z.number().int().describe("Effect slot index (bus_effect remove, set_enabled).").optional(),
      enabled: z.boolean().describe("Enable or disable the effect (bus_effect set_enabled).").optional(),
      node_path: z.string().describe("AudioStreamPlayer node (player).").optional(),
      position: z.number().describe("Playback start offset in seconds (player play).").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );
}
