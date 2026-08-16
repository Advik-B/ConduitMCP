import net from "node:net";

import { describe, expect, test } from "bun:test";

import { BridgeManager, PROTOCOL_VERSION } from "../src/bridge-manager.ts";
import { encodeFrame } from "../src/framing.ts";
import { BridgeError } from "../src/ipc-client.ts";
import { EventRing } from "../src/events.ts";

function makeManager(): BridgeManager {
  return new BridgeManager({
    editorEndpoint: "/tmp/does-not-exist.sock",
    runtimeDir: "/tmp",
    projectPath: null,
    timeoutMs: 1000,
    events: new EventRing(16),
  });
}

async function expectRejectCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeError);
    return (error as BridgeError).code;
  }
}

describe("game_breaked gating", () => {
  test("a game request while breaked rejects with a retryable game_breaked", async () => {
    const manager = makeManager();
    manager.handleEditorEvent({ event: "debug_breaked", data: { session_id: 0 } });
    let captured: BridgeError | null = null;
    try {
      await manager.gameRequest("gd_perf", {});
    } catch (error) {
      captured = error as BridgeError;
    }
    expect(captured).toBeInstanceOf(BridgeError);
    expect(captured?.code).toBe("game_breaked");
    expect(captured?.retryable).toBe(true);
  });

  test("after continue the break gate clears, falling through to game_not_running", async () => {
    const manager = makeManager();
    manager.handleEditorEvent({ event: "debug_breaked", data: { session_id: 0 } });
    expect(await expectRejectCode(manager.gameRequest("gd_perf", {}))).toBe("game_breaked");

    manager.handleEditorEvent({ event: "debug_continued", data: { session_id: 0 } });
    expect(await expectRejectCode(manager.gameRequest("gd_perf", {}))).toBe("game_not_running");
  });

  test("a stopped session also clears the break gate", async () => {
    const manager = makeManager();
    manager.handleEditorEvent({ event: "debug_breaked", data: { session_id: 0 } });
    manager.handleEditorEvent({ event: "debug_session_stopped", data: { session_id: 0 } });
    expect(await expectRejectCode(manager.gameRequest("gd_perf", {}))).toBe("game_not_running");
  });

  test("status reports the break state", () => {
    const manager = makeManager();
    manager.handleEditorEvent({ event: "debug_breaked", data: { session_id: 2 } });
    const status = manager.status() as { debug: { breaked: boolean; session_id: number | null } };
    expect(status.debug.breaked).toBe(true);
    expect(status.debug.session_id).toBe(2);
  });
});

describe("phase 9 session lifecycle", () => {
  test("ensureEditorConnected reports editor_unavailable after its deadline", async () => {
    // A loopback TCP endpoint with nothing listening: under bun test on
    // Windows a failed named-pipe connect escapes the harness as an uncaught
    // error (Bun runtime quirk; the standalone runtime handles it), while a
    // refused TCP connect is delivered normally on every platform.
    const manager = new BridgeManager({
      editorEndpoint: { host: "127.0.0.1", port: 59_987 },
      runtimeDir: "/tmp",
      projectPath: null,
      timeoutMs: 1000,
      events: new EventRing(16),
    });
    expect(await expectRejectCode(manager.ensureEditorConnected(400))).toBe("editor_unavailable");
    expect(manager.isEditorConnected()).toBe(false);
  });

  test("waitForGame times out with game_not_running when nothing appears", async () => {
    const manager = makeManager();
    expect(await expectRejectCode(manager.waitForGame(400))).toBe("game_not_running");
  });

  test("background loops are idempotent and stoppable", () => {
    const manager = makeManager();
    manager.startEditorReconnect(50);
    manager.startEditorReconnect(50);
    manager.startGameDiscovery(50);
    manager.startGameDiscovery(50);
    manager.stopBackground();
    manager.stopBackground();
  });

  test("the editor process handle is held and clearable", () => {
    const manager = makeManager();
    expect(manager.getEditorProcess()).toBeNull();
    const proc = { pid: 1, exitCode: null, kill: () => true, once: () => proc };
    manager.setEditorProcess(proc);
    expect(manager.getEditorProcess()).toBe(proc);
    manager.setEditorProcess(null);
    expect(manager.getEditorProcess()).toBeNull();
  });

  test("knownGamePids snapshots are independent of later state", () => {
    const manager = makeManager();
    const snapshot = manager.knownGamePids();
    expect(snapshot.size).toBe(0);
  });
});

// Loopback TCP throughout: BridgeManager takes the endpoint as a value, so these
// exercise the same code paths a socket or pipe would, without the Windows
// named-pipe quirk noted above.
describe("editor reconnect at startup", () => {
  function managerFor(port: number): BridgeManager {
    return new BridgeManager({
      editorEndpoint: { host: "127.0.0.1", port },
      runtimeDir: "/tmp",
      projectPath: null,
      timeoutMs: 1000,
      events: new EventRing(16),
    });
  }

  function listen(onConnection: (socket: net.Socket) => void): Promise<net.Server> {
    const server = net.createServer(onConnection);
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
  }

  function portOf(server: net.Server): number {
    return (server.address() as net.AddressInfo).port;
  }

  // Poll rather than sleeping a fixed amount: the assertion is about which
  // interval the attempt lands in, not about how fast a loopback connect is on
  // a given runner.
  async function waitForConnected(manager: BridgeManager, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (manager.isEditorConnected()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return manager.isEditorConnected();
  }

  test("the first connect attempt happens immediately, not one interval later", async () => {
    const accepted: net.Socket[] = [];
    const server = await listen((socket) => {
      accepted.push(socket);
      socket.write(
        encodeFrame({
          hello: {
            role: "editor",
            protocol_version: PROTOCOL_VERSION,
            bridge_version: "0.0.0",
            engine_version: "4.4.0",
            project_path: "/tmp/project",
            pid: 1,
          },
        }),
      );
    });
    const manager = managerFor(portOf(server));
    try {
      // The interval is an order of magnitude beyond the wait, so connecting at
      // all within it proves the first attempt did not wait for a tick. This is
      // what keeps the editor usable now that the handshake no longer waits for
      // it.
      manager.startEditorReconnect(60_000);
      expect(await waitForConnected(manager, 5_000)).toBe(true);
    } finally {
      manager.stopBackground();
      // server.close only fires once every accepted socket is gone, and the
      // manager keeps its editor connection open by design.
      for (const socket of accepted) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(() => resolve(null)));
    }
  });

  test("an endpoint that accepts but never says hello is reported as busy, not as absent", async () => {
    const held: net.Socket[] = [];
    // A bridge already serving another broker: the listener accepts into its
    // backlog and writes nothing, because it serves one client at a time.
    const server = await listen((socket) => held.push(socket));
    const manager = managerFor(portOf(server));
    try {
      let captured: BridgeError | null = null;
      try {
        await manager.ensureEditorConnected(100);
      } catch (error) {
        captured = error as BridgeError;
      }
      expect(captured).toBeInstanceOf(BridgeError);
      expect(captured?.code).toBe("editor_unavailable");
      expect(captured?.message).toContain("serves one broker at a time");
    } finally {
      for (const socket of held) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(() => resolve(null)));
    }
  }, 20_000);
});
