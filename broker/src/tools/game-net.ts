// Runtime networking tools (whitepaper section 8 "Networking", phase 9).
// Eval-class surface: registered only when --disable-eval is absent, because a
// game that can reach the network on the agent's behalf is an open-world
// capability of the same order as arbitrary evaluation (section 9).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { type Timeouts, makeGameTool } from "../tool-helpers.ts";

export function registerGameNetTools(server: McpServer, manager: BridgeManager, timeouts?: Timeouts): void {
  const gameTool = makeGameTool(server, manager, timeouts);

  gameTool(
    "gd_http_request",
    "Perform an HTTP(S) request from the running game through an HTTPRequest node and return status, headers, and body (truncated at max_body_bytes with an explicit marker). Transport failures return the retryable network_error.",
    {
      url: z.string().describe("Request URL; must start with http:// or https://."),
      method: z.enum(["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"]).describe("HTTP method (default GET).").optional(),
      headers: z
        .union([z.record(z.string(), z.string()), z.array(z.string())])
        .describe("Request headers: an object map or an array of 'Name: value' lines.")
        .optional(),
      body: z.string().describe("Request body text.").optional(),
      timeout_s: z.number().min(1).max(120).describe("Request timeout in seconds (default 30).").optional(),
      max_body_bytes: z.number().int().min(1).describe("Response body byte cap (default 65536).").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    "await",
  );

  gameTool(
    "gd_websocket",
    "WebSocket client in the running game, selected by op: connect (returns a connection id), send (text), recv (waits up to timeout_s for the next message), close, or status. Peers are polled every frame by the bridge.",
    {
      op: z.enum(["connect", "send", "recv", "close", "status"]).describe("Which websocket operation to perform."),
      url: z.string().describe("ws:// or wss:// URL (op=connect).").optional(),
      id: z.number().int().describe("Connection id from op=connect (send, recv, close).").optional(),
      text: z.string().describe("Text message to send (op=send).").optional(),
      timeout_s: z.number().min(0).max(60).describe("How long recv waits for a message (default 10).").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    "await",
  );

  gameTool(
    "gd_multiplayer",
    "ENet multiplayer lifecycle on the game's MultiplayerAPI, selected by op: create_server, create_client, disconnect, status (connection state and peer list), rpc (call an RPC-configured method, optionally to one peer_id), or rpc_config.",
    {
      op: z
        .enum(["create_server", "create_client", "disconnect", "status", "rpc", "rpc_config"])
        .describe("Which multiplayer operation to perform."),
      port: z.number().int().min(1).max(65535).describe("Server or client port (create_server, create_client).").optional(),
      address: z.string().describe("Server address to connect to (create_client).").optional(),
      max_clients: z.number().int().min(1).max(4095).describe("Server client cap (create_server, default 32).").optional(),
      node_path: z.string().describe("Absolute path to the RPC target node (rpc, rpc_config).").optional(),
      method: z.string().describe("Method name (rpc, rpc_config).").optional(),
      args: z.array(z.any()).describe("RPC arguments (rpc).").optional(),
      peer_id: z.number().int().describe("Send the RPC to one peer instead of broadcasting (rpc).").optional(),
      config: z.any().describe("rpc_config dictionary: rpc_mode, transfer_mode, call_local, channel (rpc_config).").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  );
}
