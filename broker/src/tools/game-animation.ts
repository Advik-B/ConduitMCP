// gd_animation: AnimationPlayer transport, property tweens, runtime animation
// authoring, AnimationTree state machines, and Skeleton3D bone poses
// (whitepaper section 8 "Animation", phase 8).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { makeGameTool } from "../tool-helpers.ts";

export function registerGameAnimationTools(server: McpServer, manager: BridgeManager): void {
  const gameTool = makeGameTool(server, manager);

  gameTool(
    "gd_animation",
    "Animation control selected by op. AnimationPlayer: play, pause, stop, seek, queue, set_speed, state, list, and create (value tracks with keyframes). tween eases any node property. tree drives an AnimationTree state machine (action: travel, start, stop, state). bone_get and bone_set read and pose Skeleton3D bones.",
    {
      op: z
        .enum([
          "play",
          "pause",
          "stop",
          "seek",
          "queue",
          "set_speed",
          "state",
          "list",
          "tween",
          "create",
          "tree",
          "bone_get",
          "bone_set",
        ])
        .describe("Which animation operation to perform."),
      node_path: z
        .string()
        .describe("Absolute path to the AnimationPlayer, tween target, AnimationTree, or Skeleton3D."),
      name: z.string().describe("Animation name (play, queue, create).").optional(),
      custom_speed: z.number().describe("Playback speed multiplier (play).").optional(),
      from_end: z.boolean().describe("Play from the end backwards (play).").optional(),
      keep_state: z.boolean().describe("Keep animated values when stopping (stop).").optional(),
      seconds: z.number().describe("Position in seconds (seek).").optional(),
      update: z.boolean().describe("Apply the seeked values immediately (seek, default true).").optional(),
      speed: z.number().describe("Speed scale (set_speed).").optional(),
      property: z.string().describe("Property to tween (tween).").optional(),
      to: z
        .any()
        .describe("Tween target value (tagged Variant JSON accepted), or state name for tree travel/start.")
        .optional(),
      duration: z.number().describe("Tween duration in seconds (tween).").optional(),
      trans: z
        .string()
        .describe("Tween transition: linear, sine, quad, cubic, quart, quint, expo, elastic, circ, bounce, back, spring.")
        .optional(),
      ease: z.string().describe("Tween easing: in, out, in_out, out_in.").optional(),
      length: z.number().describe("Animation length in seconds (create).").optional(),
      loop: z.boolean().describe("Loop the created animation (create).").optional(),
      tracks: z
        .array(z.any())
        .describe("Value tracks (create): [{path, keys: [{time, value}]}] with node:property paths.")
        .optional(),
      action: z.enum(["travel", "start", "stop", "state"]).describe("State machine action (tree).").optional(),
      bone: z.union([z.string(), z.number()]).describe("Bone name or index (bone_get, bone_set).").optional(),
      position: z.any().describe("Bone pose position {x,y,z} (bone_set).").optional(),
      rotation: z.any().describe("Bone pose rotation quaternion {x,y,z,w} (bone_set).").optional(),
      scale: z.any().describe("Bone pose scale {x,y,z} (bone_set).").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );
}
