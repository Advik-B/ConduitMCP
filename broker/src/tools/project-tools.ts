// Project-defined tools (whitepaper section 8, phase 9): methods of game nodes
// in the conduit_tools group surface as dynamic gd_project_{method} MCP tools.
//
// The registry is driven by game lifecycle: on game_started it pulls
// gd_project_tools_list, on project_tools_changed events it re-syncs, and on
// game_exited it clears. Registration and removal happen after the MCP
// transport is connected, so the SDK emits notifications/tools/list_changed
// for every change automatically. These tools execute project code, so they
// are eval-class: --disable-eval drops the whole mechanism (section 9).

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { DEFAULT_TIMEOUTS, type Timeouts, instanceField, textResult, toToolError } from "../tool-helpers.ts";

export interface ToolEntryArg {
  name: string;
  type: string;
  required: boolean;
}

export interface ToolEntry {
  method: string;
  node_path: string;
  args: ToolEntryArg[];
  return_type: string;
}

// MCP tool names must stay predictable and collision-safe; anything else is
// skipped with a warning rather than surfaced under a mangled name.
const METHOD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;

function log(message: string): void {
  process.stderr.write(`conduit-broker: ${message}\n`);
}

/** Zod schema fields for a project tool's typed signature. Exported for tests. */
export function deriveInputSchema(entry: ToolEntry): Record<string, z.ZodTypeAny> {
  const fields: Record<string, z.ZodTypeAny> = {};
  for (const arg of entry.args) {
    let field: z.ZodTypeAny;
    switch (arg.type) {
      case "int":
        field = z.number().int().describe(`${arg.name} (Godot int).`);
        break;
      case "float":
        field = z.number().describe(`${arg.name} (Godot float).`);
        break;
      case "bool":
        field = z.boolean().describe(`${arg.name} (Godot bool).`);
        break;
      case "String":
      case "StringName":
      case "NodePath":
        field = z.string().describe(`${arg.name} (Godot ${arg.type}).`);
        break;
      case "Variant":
        field = z.any().describe(`${arg.name}: untyped (Variant); plain JSON or a tagged Godot type ({"__type": ...}).`);
        break;
      default:
        field = z.any().describe(`${arg.name}: Godot ${arg.type} as plain JSON or tagged form ({"__type": "${arg.type}", ...}).`);
        break;
    }
    fields[arg.name] = arg.required ? field : field.optional();
  }
  return { ...fields, ...instanceField };
}

function describeTool(entry: ToolEntry): string {
  const argList = entry.args.map((arg) => `${arg.name}: ${arg.type}${arg.required ? "" : " (optional)"}`).join(", ");
  return `Project-defined tool: calls ${entry.method}(${argList}) -> ${entry.return_type} on the conduit_tools node ${entry.node_path} in the running game. Executes project code.`;
}

/** The identity a registration is keyed on; a change means re-register. */
function signatureKey(entry: ToolEntry): string {
  return JSON.stringify({ node_path: entry.node_path, args: entry.args, return_type: entry.return_type });
}

export class ProjectToolsRegistry {
  private readonly registered = new Map<string, { tool: RegisteredTool; key: string }>();

  constructor(
    private readonly server: McpServer,
    private readonly manager: BridgeManager,
    private readonly timeouts: Timeouts = DEFAULT_TIMEOUTS,
  ) {}

  /** Pull the current tool list from the connected game and sync to it. */
  async refreshFromGame(): Promise<void> {
    const result = (await this.manager.gameRequest("gd_project_tools_list", {}, this.timeouts.default)) as {
      tools: ToolEntry[];
    };
    this.sync(result.tools ?? []);
  }

  /** Reconcile the registered dynamic tools with a reported tool list. */
  sync(tools: ToolEntry[]): void {
    const incoming = new Map<string, ToolEntry>();
    for (const entry of tools) {
      if (!METHOD_NAME_PATTERN.test(entry.method)) {
        log(`project tool skipped: method name '${entry.method}' is not a valid tool name`);
        continue;
      }
      if (incoming.has(entry.method)) {
        // Two group nodes exposing the same method: first node wins.
        log(`project tool collision: '${entry.method}' also on ${entry.node_path}; keeping ${incoming.get(entry.method)?.node_path}`);
        continue;
      }
      incoming.set(entry.method, entry);
    }

    for (const [method, registration] of [...this.registered]) {
      const replacement = incoming.get(method);
      if (!replacement || signatureKey(replacement) !== registration.key) {
        registration.tool.remove();
        this.registered.delete(method);
      }
    }

    for (const [method, entry] of incoming) {
      if (this.registered.has(method)) {
        continue;
      }
      const name = `gd_project_${method}`;
      try {
        const tool = this.server.registerTool(
          name,
          {
            description: describeTool(entry),
            inputSchema: deriveInputSchema(entry),
            // Project tools run arbitrary project code: destructive by default
            // (section 9), never assumed idempotent.
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
          },
          async (callArgs) => {
            try {
              const { instance, ...rest } = callArgs as Record<string, unknown> & { instance?: number };
              const result = await this.manager.gameRequest(
                "gd_project_call",
                { method: entry.method, node_path: entry.node_path, args: rest },
                // The eval budget, not the ordinary one: a project tool runs
                // arbitrary project code and may await, exactly like
                // gd_game_eval and gd_editor_eval, which both get it.
                this.timeouts.await,
                instance,
              );
              return textResult(result);
            } catch (error) {
              return toToolError(error);
            }
          },
        );
        this.registered.set(method, { tool, key: signatureKey(entry) });
      } catch (error) {
        // A static tool already claims this name (for example a project method
        // named 'scaffold' colliding with gd_project_scaffold): skip it.
        log(`project tool '${name}' not registered: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Drop every dynamic tool (the game exited). */
  clear(): void {
    for (const [method, registration] of [...this.registered]) {
      registration.tool.remove();
      this.registered.delete(method);
    }
  }

  /** Currently registered dynamic tool names, for status and tests. */
  names(): string[] {
    return [...this.registered.keys()].map((method) => `gd_project_${method}`).sort();
  }
}
