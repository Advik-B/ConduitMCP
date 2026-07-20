#!/usr/bin/env bun
// Conduit broker: an MCP server over stdio that forwards tool calls to the
// Godot bridge over a local socket. Phase 1 exposes the two proof tools,
// gd_ping and gd_wait_frames. The broker owns MCP correctness; the bridge owns
// engine work (whitepaper sections 6.2 and 7.1).
//
// Hard rule: nothing but MCP protocol frames may reach stdout. All broker
// logging goes to stderr (whitepaper section 7.1).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { BridgeClient, BridgeError, DEFAULT_TIMEOUT_MS } from "./ipc-client.ts";
import { shortHash } from "./framing.ts";

const AWAIT_TIMEOUT_MS = 120_000;

function log(message: string): void {
  process.stderr.write(`conduit-broker: ${message}\n`);
}

function resolveSocketPath(): string {
  const explicit = process.env.CONDUIT_SOCK;
  if (explicit) {
    return explicit;
  }
  const project = process.env.CONDUIT_PROJECT;
  if (!project) {
    throw new Error("set CONDUIT_SOCK or CONDUIT_PROJECT so the broker can locate the bridge socket");
  }
  return `${require("node:os").tmpdir()}/conduit-editor-${shortHash(project)}.sock`;
}

function toToolError(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  if (error instanceof BridgeError) {
    return { content: [{ type: "text", text: `${error.code}: ${error.message}` }], isError: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `internal_error: ${message}` }], isError: true };
}

export function registerTools(server: McpServer, client: BridgeClient): void {
  server.registerTool(
    "gd_ping",
    {
      description:
        "Round-trip a no-op command through the bridge to prove the editor is connected and responsive. Returns the editor's current frame index and last inter-frame delta in milliseconds.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const result = await client.request("gd_ping", {}, DEFAULT_TIMEOUT_MS);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "gd_wait_frames",
    {
      description:
        "Wait for a number of rendered editor frames, then return. Completes via deferred resolution across frames without blocking the engine; the same mechanism carries await-based evaluation in later phases.",
      inputSchema: {
        frames: z.number().int().min(1).describe("Number of frames to wait before the command resolves."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ frames }) => {
      try {
        const result = await client.request("gd_wait_frames", { frames }, AWAIT_TIMEOUT_MS);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return toToolError(error);
      }
    },
  );
}

async function main(): Promise<void> {
  const socketPath = resolveSocketPath();
  const client = new BridgeClient({ socketPath });
  log(`connecting to bridge at ${socketPath}`);
  await client.connect();
  log("connected");

  const server = new McpServer({ name: "conduit", version: "0.1.0" });
  registerTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server ready on stdio");
}

if (import.meta.main) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
