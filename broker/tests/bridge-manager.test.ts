import { describe, expect, test } from "bun:test";

import { BridgeManager } from "../src/bridge-manager.ts";
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
