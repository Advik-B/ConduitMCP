import { describe, expect, test } from "bun:test";

import { BridgeManager } from "../src/bridge-manager.ts";
import { BridgeError } from "../src/ipc-client.ts";
import { EventRing } from "../src/events.ts";

function makeManager(): BridgeManager {
  return new BridgeManager({
    editorSocketPath: "/tmp/does-not-exist.sock",
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
