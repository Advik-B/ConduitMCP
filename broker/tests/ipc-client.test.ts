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

/**
 * A fake bridge for the liveness tests, which sends first and may deliberately
 * not answer. `onFrame` sees every frame the client sends, so a test decides
 * whether to pong.
 */
function startLivenessBridge(
  path: string,
  onFrame: (frame: Record<string, unknown>, socket: net.Socket) => void,
): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.write(
        encodeFrame({
          hello: {
            role: "editor",
            protocol_version: 1,
            bridge_version: "0.0.0",
            engine_version: "4.4.0",
            project_path: "/tmp/project",
            pid: 1,
          },
        }),
      );
      const parser = new FrameParser();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of parser.push(chunk)) {
          onFrame(JSON.parse(frame.toString("utf8")) as Record<string, unknown>, socket);
        }
      });
      socket.on("error", () => {});
    });
    server.listen(path, () => resolve(server));
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
        setTimeout(tick, 10);
      }
    };
    tick();
  });
}

let socketPath: string;
let server: net.Server | null = null;
const isWindows = process.platform === "win32";

beforeEach(() => {
  const id = `conduit-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  // net IPC is a named pipe on Windows and a filesystem socket elsewhere.
  socketPath = isWindows ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
});

afterEach(() => {
  server?.close();
  server = null;
  if (!isWindows) {
    rmSync(socketPath, { force: true });
  }
});

describe("BridgeClient", () => {
  test("correlates a response to its request by id", async () => {
    server = await startFakeBridge(socketPath, (req, reply) => {
      reply(encodeFrame({ id: req.id, ok: true, result: { echoed: req.tool } }));
    });
    const client = new BridgeClient({ endpoint: socketPath });
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
    const client = new BridgeClient({ endpoint: socketPath });
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
    const client = new BridgeClient({ endpoint: socketPath });
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
    const client = new BridgeClient({ endpoint: socketPath, defaultTimeoutMs: 150 });
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

// The mirror of bridge/src/transport/ipc.rs's liveness tests. A socket staying
// open proves only that some process holds the descriptor, so between tool calls
// the client asks whether the bridge is still able to act.
describe("BridgeClient liveness", () => {
  test("answers the bridge's ping with a pong carrying the same sequence", async () => {
    // The bridge pings too, and its own deadline depends on this reply. The
    // sequence must come back unchanged so the answer is attributable to that
    // ping rather than to any traffic at all.
    const replies: Array<Record<string, unknown>> = [];
    server = await startLivenessBridge(socketPath, (frame) => replies.push(frame));
    server.on("connection", (socket) => socket.write(encodeFrame({ ping: 4242 })));

    const client = new BridgeClient({ endpoint: socketPath });
    await client.connect();
    await client.waitForHello(2_000);

    expect(await waitFor(() => replies.some((frame) => frame.pong === 4242), 2_000)).toBe(true);
    client.close();
  });

  test("a bridge that goes silent after answering once is dropped", async () => {
    let pongs = 0;
    server = await startLivenessBridge(socketPath, (frame, socket) => {
      if (typeof frame.ping === "number") {
        pongs += 1;
        // Answer exactly the first ping. That arms the deadline by proving the
        // peer speaks the protocol, then it goes silent while holding the
        // socket open, which is the case no socket close ever reports.
        if (pongs === 1) {
          socket.write(encodeFrame({ pong: frame.ping }));
        }
      }
    });
    const client = new BridgeClient({ endpoint: socketPath });
    let closed = false;
    client.onClose = () => {
      closed = true;
    };
    await client.connect();
    await client.waitForHello(2_000);
    client.startLiveness({ pingAfterMs: 60, timeoutMs: 300, intervalMs: 20 });

    expect(await waitFor(() => closed, 5_000)).toBe(true);
    expect(pongs).toBeGreaterThan(1);
    expect(client.isConnected()).toBe(false);
  });

  test("an in-flight call on a silent bridge names the silence, not a bare disconnect", async () => {
    let pings = 0;
    server = await startLivenessBridge(socketPath, (frame, socket) => {
      // Answer the first ping to arm the deadline, then go silent: commands are
      // never answered either, so the call is still pending when liveness fires.
      if (typeof frame.ping === "number" && ++pings === 1) {
        socket.write(encodeFrame({ pong: frame.ping }));
      }
    });
    const client = new BridgeClient({ endpoint: socketPath });
    await client.connect();
    await client.waitForHello(2_000);
    client.startLiveness({ pingAfterMs: 60, timeoutMs: 300, intervalMs: 20 });

    // A budget far longer than the liveness deadline, so what rejects the call
    // is the dropped link and not its own timeout.
    const pending = client.request("gd_ping", {}, 30_000);

    try {
      await pending;
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).code).toBe("disconnected");
      expect((error as BridgeError).message).toContain("liveness ping");
    }
    client.close();
  });

  test("a bridge that never answers a ping is left connected", async () => {
    // Compatibility rule, matching the bridge side: a peer too old to know the
    // frame must not be disconnected for speaking the protocol it was built
    // against, so the deadline arms only after a pong.
    let pings = 0;
    server = await startLivenessBridge(socketPath, (frame) => {
      if (typeof frame.ping === "number") {
        pings += 1;
      }
    });
    const client = new BridgeClient({ endpoint: socketPath });
    let closed = false;
    client.onClose = () => {
      closed = true;
    };
    await client.connect();
    await client.waitForHello(2_000);
    client.startLiveness({ pingAfterMs: 40, timeoutMs: 150, intervalMs: 20 });

    await waitFor(() => pings >= 3, 2_000);
    expect(closed).toBe(false);
    expect(client.isConnected()).toBe(true);
    client.close();
  });
});
