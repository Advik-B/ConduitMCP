#!/usr/bin/env bun
// Startup handshake acceptance runner. Proves the one property an MCP client
// actually depends on at launch: the broker answers `initialize` promptly, no
// matter what the editor bridge is doing.
//
// The regression this guards against shipped for several releases. main() used
// to await manager.connectEditor() before creating the stdio transport, so
// stdin went unread for that call's full ten-second retry deadline. A client
// waiting on the initialize response reports that as "MCP server timeout", and
// it was worst in the case users hit most: a bridge already serving another
// broker accepts the connection and then never sends a hello, costing a full
// five-second timeout per attempt rather than an instant refusal.
//
// Covered:
//   - no editor endpoint at all: the handshake completes and tools list;
//   - an endpoint that accepts and then stays silent, which is what a bridge
//     already serving another broker looks like: the handshake is just as fast;
//   - gd_status answers in that state and explains why the editor is absent,
//     which is the diagnosis path that a blocked handshake used to hide.
//
// Needs no Godot binary and no network, so it runs everywhere `bun` does.
// Run with `bun tests/evals/startup_handshake.ts`.

import net from "node:net";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { encodeFrame } from "../../broker/src/framing.ts";
import { editorEndpointFor, endpointKey, repoRoot, runtimeDir } from "./harness.ts";

// Generous next to the ~360 ms a warm handshake takes, and still far below the
// ~10.6 s the blocking connect cost. The gap is wide enough that CI variance on
// a cold Windows runner cannot reach it, and a reintroduced await cannot hide
// under it.
const HANDSHAKE_BUDGET_MS = 5_000;

const RUNTIME_DIR = runtimeDir("handshake");
const WORK_DIR = mkdtempSync(join(os.tmpdir(), "conduit-handshake-eval-"));
const PROJECT_DIR = join(WORK_DIR, "project");

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

/**
 * Connect a real MCP client to a freshly spawned broker and report how long the
 * handshake took. The SDK client is deliberately the measuring instrument: it
 * frames stdout as a transport, so a broker that logged a stray line to stdout
 * would fail here rather than merely being slow.
 */
async function timeHandshake(): Promise<{ ms: number; client: Client }> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(repoRoot, "broker", "src", "index.ts"), "--project", PROJECT_DIR],
    env: { ...process.env, CONDUIT_RUNTIME_DIR: RUNTIME_DIR } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "startup-handshake-eval", version: "0" });
  const started = Date.now();
  await client.connect(transport);
  return { ms: Date.now() - started, client };
}

/**
 * A listener at the editor endpoint that accepts connections and then says
 * nothing, standing in for a bridge whose single accept slot is occupied by
 * another broker. Sockets are held open rather than closed, because a close
 * would let the broker fail fast and would not reproduce the stall.
 */
function silentListener(endpoint: string): Promise<net.Server> {
  const held: net.Socket[] = [];
  const server = net.createServer((socket) => held.push(socket));
  server.on("error", () => {});
  (server as net.Server & { heldSockets: net.Socket[] }).heldSockets = held;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => resolve(server));
  });
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (predicate()) {
        resolve(true);
      } else if (Date.now() >= deadline) {
        resolve(false);
      } else {
        setTimeout(tick, 20);
      }
    };
    tick();
  });
}

function closeListener(server: net.Server): Promise<void> {
  for (const socket of (server as net.Server & { heldSockets?: net.Socket[] }).heldSockets ?? []) {
    socket.destroy();
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

async function main(): Promise<void> {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  mkdirSync(PROJECT_DIR, { recursive: true });

  console.log("startup handshake acceptance");

  // No endpoint exists, so every connect attempt refuses instantly. The old code
  // still burned its whole retry deadline here.
  {
    const { ms, client } = await timeHandshake();
    record(
      "handshake with no editor endpoint",
      ms < HANDSHAKE_BUDGET_MS,
      `initialize answered in ${ms}ms (budget ${HANDSHAKE_BUDGET_MS}ms)`,
    );
    const tools = await client.listTools();
    record("tools are listed", tools.tools.length > 0, `${tools.tools.length} tools registered`);
    await client.close();
  }

  // The case behind the bug report: something is listening, so the socket
  // connects, but no hello ever arrives.
  {
    const endpoint = editorEndpointFor(RUNTIME_DIR, PROJECT_DIR);
    if (typeof endpoint !== "string") {
      throw new Error("this runner does not support the TCP transport; unset CONDUIT_TCP");
    }
    const server = await silentListener(endpoint);
    try {
      const { ms, client } = await timeHandshake();
      record(
        "handshake with a silent editor endpoint",
        ms < HANDSHAKE_BUDGET_MS,
        `initialize answered in ${ms}ms against a listener at ${endpointKey(endpoint)} that never sends hello`,
      );

      // The diagnosis a blocked handshake used to make unreachable.
      const status = (await client.callTool({ name: "gd_status", arguments: {} })) as {
        content: Array<{ type: string; text?: string }>;
      };
      const payload = JSON.parse(status.content[0]?.text ?? "{}") as {
        editor?: { connected?: boolean; hint?: string | null };
      };
      record(
        "gd_status answers while the editor is unreachable",
        payload.editor?.connected === false && typeof payload.editor?.hint === "string",
        `connected=${payload.editor?.connected}, hint=${payload.editor?.hint ?? "(none)"}`,
      );
      await client.close();
    } finally {
      await closeListener(server);
    }
  }

  // A broker whose MCP client has gone must let go of the bridge. Nothing else
  // makes it: the SDK's stdio transport does not watch stdin for its end, and
  // the connected bridge socket is a live handle that keeps the process up. An
  // orphan like that holds the bridge's only accept slot, so the next broker to
  // start cannot attach at all.
  {
    const endpoint = editorEndpointFor(RUNTIME_DIR, PROJECT_DIR);
    if (typeof endpoint !== "string") {
      throw new Error("this runner does not support the TCP transport; unset CONDUIT_TCP");
    }
    let socketClosed = false;
    const held: net.Socket[] = [];
    const bridge = net.createServer((socket) => {
      held.push(socket);
      socket.write(
        encodeFrame({
          hello: {
            role: "editor",
            protocol_version: 1,
            bridge_version: "0",
            engine_version: "4.4.0",
            project_path: PROJECT_DIR,
            pid: 1,
          },
        }),
      );
      socket.on("close", () => {
        socketClosed = true;
      });
      socket.on("error", () => {});
    });
    bridge.on("error", () => {});
    await new Promise<void>((resolve) => bridge.listen(endpoint, () => resolve()));

    const proc = spawn("bun", [join(repoRoot, "broker", "src", "index.ts"), "--project", PROJECT_DIR], {
      env: { ...process.env, CONDUIT_RUNTIME_DIR: RUNTIME_DIR },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let exitCode: number | null = null;
    proc.on("exit", (code) => {
      exitCode = code;
    });

    try {
      const attached = await waitFor(() => held.length > 0, 10_000);
      record("a broker attaches to the stub bridge", attached, attached ? "connected" : "never connected");

      proc.stdin.end();
      const left = await waitFor(() => exitCode !== null && socketClosed, 10_000);
      record(
        "the broker exits and releases the bridge when its client closes stdin",
        left,
        `exit=${exitCode ?? "still running"}, bridge socket closed=${socketClosed}`,
      );
    } finally {
      proc.kill();
      for (const socket of held) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
    }
  }

  const failed = checks.filter((check) => !check.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => {
    rmSync(WORK_DIR, { recursive: true, force: true });
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
  });
