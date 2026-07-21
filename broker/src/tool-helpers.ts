// Shared tool-registration plumbing (whitepaper section 7.1): the response
// envelope, error mapping, and the editor/game tool-registration factories.
// Extracted out of index.ts so new tool modules (broker/src/tools/*.ts) can
// reuse the exact same registration shape without duplicating it.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "./bridge-manager.ts";
import { BridgeError } from "./ipc-client.ts";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const AWAIT_TIMEOUT_MS = 120_000;

export type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: true;
};

export function toToolError(error: unknown): ToolResult {
  if (error instanceof BridgeError) {
    return { content: [{ type: "text", text: `${error.code}: ${error.message}` }], isError: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `internal_error: ${message}` }], isError: true };
}

export function textResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export const instanceField = {
  instance: z.number().int().describe("Game instance pid; defaults to the most recent.").optional(),
};

export type ToolRegistrar = (
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  annotations: Record<string, boolean>,
  timeoutMs?: number,
) => void;

/** Registers tools routed to the editor bridge (the single, persistent connection). */
export function makeEditorTool(server: McpServer, manager: BridgeManager): ToolRegistrar {
  return (name, description, inputSchema, annotations, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
      try {
        const result = await manager.editorRequest(name, args as Record<string, unknown>, timeoutMs);
        return textResult(result);
      } catch (error) {
        return toToolError(error);
      }
    });
  };
}

/** Registers tools routed to a game bridge instance; adds the shared `instance` field. */
export function makeGameTool(server: McpServer, manager: BridgeManager): ToolRegistrar {
  return (name, description, inputSchema, annotations, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    server.registerTool(
      name,
      { description, inputSchema: { ...inputSchema, ...instanceField }, annotations },
      async (args) => {
        try {
          const { instance, ...rest } = args as Record<string, unknown> & { instance?: number };
          const result = await manager.gameRequest(name, rest, timeoutMs, instance);
          return textResult(result);
        } catch (error) {
          return toToolError(error);
        }
      },
    );
  };
}
