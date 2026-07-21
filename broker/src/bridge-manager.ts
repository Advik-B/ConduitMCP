// Owns the persistent editor bridge connection and the on-demand game bridge
// connections, discovers game sockets after gd_play, checks the protocol
// version at the handshake, and turns a game socket closing into a game_exited
// event (whitepaper sections 6.1, 7.2, and 7.5).

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { BridgeClient, BridgeError, type Hello } from "./ipc-client.ts";
import type { EventRing } from "./events.ts";

export const PROTOCOL_VERSION = 1;

const GAME_SOCKET_PATTERN = /^conduit-game-.*\.sock$/;

export interface BridgeManagerOptions {
  editorSocketPath: string;
  runtimeDir: string;
  projectPath: string | null;
  timeoutMs: number;
  events: EventRing;
}

interface GameInstance {
  client: BridgeClient;
  hello: Hello;
  socketPath: string;
}

function log(message: string): void {
  process.stderr.write(`conduit-broker: ${message}\n`);
}

function normalizeProjectPath(path: string): string {
  return path.replace(/\/+$/, "");
}

export class BridgeManager {
  private editor: BridgeClient | null = null;
  private editorHello: Hello | null = null;
  private readonly games = new Map<number, GameInstance>();
  private currentPid: number | null = null;
  private readonly connectedSockets = new Set<string>();
  // Break state learned from the editor bridge's debugger events. While the game
  // is halted at a breakpoint its main loop does not run, so game-bridge tools
  // cannot complete; the broker reports game_breaked instead of a timeout
  // (whitepaper section 6.9). One global flag, not per-pid: debug sessions are
  // editor-session-scoped and not mapped to a game pid (docs/api-gaps.md).
  private debug: { breaked: boolean; sessionId: number | null } = { breaked: false, sessionId: null };

  constructor(private readonly options: BridgeManagerOptions) {}

  async connectEditor(retryMs = 10_000): Promise<Hello> {
    const deadline = Date.now() + retryMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      const client = new BridgeClient({ socketPath: this.options.editorSocketPath, defaultTimeoutMs: this.options.timeoutMs });
      try {
        await client.connect();
        const hello = await client.waitForHello(5_000);
        checkProtocol(hello);
        client.onEvent = (event) => this.handleEditorEvent(event);
        client.onClose = () => {
          this.editor = null;
          this.options.events.record("editor_disconnected", {});
        };
        this.editor = client;
        this.editorHello = hello;
        // Resync break state: events emitted while the broker was disconnected
        // are dropped bridge-side, so read the current state once on connect.
        void this.resyncDebugState();
        return hello;
      } catch (error) {
        lastError = error;
        client.close();
        await sleep(300);
      }
    }
    throw new BridgeError({
      code: "editor_unavailable",
      message: `could not connect to the editor bridge at ${this.options.editorSocketPath}: ${String(lastError)}`,
      retryable: true,
    });
  }

  editorRequest(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (!this.editor) {
      return Promise.reject(
        new BridgeError({ code: "editor_unavailable", message: "not connected to the editor bridge", retryable: true }),
      );
    }
    return this.editor.request(tool, args, timeoutMs);
  }

  gameRequest(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
    instance?: number,
  ): Promise<unknown> {
    // A breaked game cannot service tools: its main loop is halted inside the
    // debugger, so its bridge never drains. Fail fast and distinctly rather than
    // letting the call time out (whitepaper section 6.9).
    if (this.debug.breaked) {
      return Promise.reject(
        new BridgeError({
          code: "game_breaked",
          message:
            "the game is halted at a breakpoint, so game-bridge tools cannot run; use gd_debug (stack, vars, step_over, step_into) or gd_debug op continue to resume",
          retryable: true,
        }),
      );
    }
    const game = instance != null ? this.games.get(instance) : this.currentGame();
    if (!game) {
      return Promise.reject(
        new BridgeError({
          code: "game_not_running",
          message: "no game instance is connected; call gd_play first",
          retryable: true,
        }),
      );
    }
    return game.client.request(tool, args, timeoutMs);
  }

  // Editor-bridge events are debugger lifecycle transitions (whitepaper section
  // 7.5). Mirror break state so gameRequest can gate, and forward every event to
  // the ring so gd_get_events surfaces it. Exposed for unit tests.
  handleEditorEvent(event: { event: string; data?: unknown }): void {
    const data = (event.data ?? {}) as { session_id?: number };
    switch (event.event) {
      case "debug_breaked":
        this.debug = { breaked: true, sessionId: data.session_id ?? null };
        break;
      case "debug_continued":
      case "debug_session_stopped":
        this.debug = { breaked: false, sessionId: null };
        break;
      default:
        break;
    }
    this.options.events.record(event.event, data as object);
  }

  private async resyncDebugState(): Promise<void> {
    try {
      const state = (await this.editorRequest("gd_editor_get_state", {})) as {
        debug?: { sessions?: Array<{ id: number; breaked: boolean }> };
      };
      const breakedSession = state.debug?.sessions?.find((s) => s.breaked);
      this.debug = breakedSession
        ? { breaked: true, sessionId: breakedSession.id }
        : { breaked: false, sessionId: null };
    } catch {
      // Best-effort; a failed resync leaves the last known state.
    }
  }

  private currentGame(): GameInstance | null {
    if (this.currentPid != null) {
      return this.games.get(this.currentPid) ?? null;
    }
    return null;
  }

  // Poll the runtime directory for a game socket that appeared since we last
  // looked, connect to it, and register it as the current instance.
  async waitForGame(timeoutMs: number): Promise<GameInstance> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const socketPath of this.newGameSockets()) {
        const instance = await this.tryConnectGame(socketPath);
        if (instance) {
          return instance;
        }
      }
      await sleep(200);
    }
    throw new BridgeError({
      code: "game_not_running",
      message: "the game bridge did not connect; confirm the game was launched with the conduit opt-in",
      retryable: true,
    });
  }

  private newGameSockets(): string[] {
    let entries: string[];
    try {
      entries = readdirSync(this.options.runtimeDir);
    } catch {
      return [];
    }
    return entries
      .filter((name) => GAME_SOCKET_PATTERN.test(name))
      .map((name) => join(this.options.runtimeDir, name))
      .filter((path) => !this.connectedSockets.has(path));
  }

  private async tryConnectGame(socketPath: string): Promise<GameInstance | null> {
    const client = new BridgeClient({ socketPath, defaultTimeoutMs: this.options.timeoutMs });
    try {
      await client.connect();
      const hello = await client.waitForHello(3_000);
      checkProtocol(hello);
      if (hello.role !== "game") {
        client.close();
        return null;
      }
      if (!this.matchesProject(hello)) {
        client.close();
        return null;
      }

      const instance: GameInstance = { client, hello, socketPath };
      client.onEvent = (event) => this.options.events.record(event.event, { ...(event.data as object), pid: hello.pid });
      client.onClose = () => this.handleGameClose(hello.pid, socketPath);

      this.games.set(hello.pid, instance);
      this.currentPid = hello.pid;
      this.connectedSockets.add(socketPath);
      this.options.events.record("game_started", { pid: hello.pid, engine_version: hello.engine_version });
      log(`game bridge connected (pid ${hello.pid}, engine ${hello.engine_version})`);
      return instance;
    } catch (error) {
      // The socket may exist before the game finishes binding; leave it for the
      // next poll rather than marking it connected.
      log(`game socket ${socketPath} not ready yet: ${String(error)}`);
      client.close();
      return null;
    }
  }

  private matchesProject(hello: Hello): boolean {
    if (!this.options.projectPath) {
      return true;
    }
    return normalizeProjectPath(hello.project_path) === normalizeProjectPath(this.options.projectPath);
  }

  private handleGameClose(pid: number, socketPath: string): void {
    this.games.delete(pid);
    this.connectedSockets.delete(socketPath);
    if (this.currentPid === pid) {
      this.currentPid = null;
    }
    this.options.events.record("game_exited", { pid, reason: "socket_closed" });
    log(`game bridge disconnected (pid ${pid})`);
  }

  listGames(): Array<{ pid: number; engine_version: string; current: boolean }> {
    return [...this.games.values()].map((instance) => ({
      pid: instance.hello.pid,
      engine_version: instance.hello.engine_version,
      current: instance.hello.pid === this.currentPid,
    }));
  }

  status(): Record<string, unknown> {
    return {
      editor: {
        connected: this.editor != null,
        engine_version: this.editorHello?.engine_version ?? null,
        protocol_version: this.editorHello?.protocol_version ?? null,
      },
      games: this.listGames(),
      debug: { breaked: this.debug.breaked, session_id: this.debug.sessionId },
    };
  }
}

function checkProtocol(hello: Hello): void {
  if (hello.protocol_version !== PROTOCOL_VERSION) {
    throw new BridgeError({
      code: "protocol_mismatch",
      message: `bridge speaks protocol ${hello.protocol_version} but this broker speaks ${PROTOCOL_VERSION}; update the mismatched component`,
      retryable: false,
    });
  }
}
