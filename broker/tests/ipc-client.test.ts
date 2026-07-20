import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeFrame, FrameParser } from "../src/framing.ts";
import { BridgeClient, BridgeError } from "../src/ipc-client.ts";

interface Incoming {
  id: number;
  tool: string;
  args: Record<string, unknown>;
}

// A fake bridge that frames responses exactly as the real bridge does, so the
// client is exercised over a real socket without Godot. `respond` decides the
// reply per request and may defer or reorder to prove id correlation.
function startFakeBridge(
  path: string,
  respond: (req: Incoming, reply: (frame: Buffer) => void) => void,
): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      const parser = new FrameParser();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of parser.push(chunk)) {
          const req = JSON.parse(frame.toString("utf8")) as Incoming;
          respond(req, (out) => socket.write(out));
        }
      });
    });
    server.listen(path, () => resolve(server));
  });
}

let socketPath: string;
let server: net.Server | null = null;

beforeEach(() => {
  socketPath = join(tmpdir(), `conduit-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
});

afterEach(() => {
  server?.close();
  server = null;
  rmSync(socketPath, { force: true });
});

describe("BridgeClient", () => {
  test("correlates a response to its request by id", async () => {
    server = await startFakeBridge(socketPath, (req, reply) => {
      reply(encodeFrame({ id: req.id, ok: true, result: { echoed: req.tool } }));
    });
    const client = new BridgeClient({ socketPath });
    await client.connect();
    const result = (await client.request("gd_ping", {})) as { echoed: string };
    expect(result.echoed).toBe("gd_ping");
    client.close();
  });

  test("matches concurrent requests even when responses arrive out of order", async () => {
    const held: Array<{ id: number; reply: (frame: Buffer) => void }> = [];
    server = await startFakeBridge(socketPath, (req, reply) => {
      held.push({ id: req.id, reply });
      // Once both requests are in, answer the second one first.
      if (held.length === 2) {
        for (const h of [held[1]!, held[0]!]) {
          h.reply(encodeFrame({ id: h.id, ok: true, result: { id: h.id } }));
        }
      }
    });
    const client = new BridgeClient({ socketPath });
    await client.connect();
    const [a, b] = await Promise.all([
      client.request("gd_a", {}) as Promise<{ id: number }>,
      client.request("gd_b", {}) as Promise<{ id: number }>,
    ]);
    // Each promise resolves with the result carrying its own request id.
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    client.close();
  });

  test("rejects a busy response as a retryable BridgeError", async () => {
    server = await startFakeBridge(socketPath, (req, reply) => {
      reply(
        encodeFrame({
          id: req.id,
          ok: false,
          error: { code: "busy", message: "queue full", retryable: true },
        }),
      );
    });
    const client = new BridgeClient({ socketPath });
    await client.connect();
    try {
      await client.request("gd_ping", {});
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).code).toBe("busy");
      expect((error as BridgeError).retryable).toBe(true);
    }
    client.close();
  });

  test("times out when the bridge never answers", async () => {
    server = await startFakeBridge(socketPath, () => {
      // Intentionally silent to trigger the client timeout.
    });
    const client = new BridgeClient({ socketPath, defaultTimeoutMs: 150 });
    await client.connect();
    try {
      await client.request("gd_never", {});
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).code).toBe("timeout");
    }
    client.close();
  });
});
