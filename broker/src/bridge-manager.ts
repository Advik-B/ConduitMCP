// Owns the persistent editor bridge connection and the on-demand game bridge
// connections, discovers game sockets after gd_play, checks the protocol
// version at the handshake, and turns a game socket closing into a game_exited
// event (whitepaper sections 6.1, 7.2, and 7.5).

import { setTimeout as sleep } from "node:timers/promises";

import {
  type Endpoint,
  endpointKey,
  gameEndpointFromToken,
  listGameTokens,
  projectHash,
} from "./endpoint.ts";
import { canonicalProjectKey } from "./framing.ts";
import { BridgeClient, BridgeError, type Hello } from "./ipc-client.ts";
import type { EventRing } from "./events.ts";

export const PROTOCOL_VERSION = 1;

export interface BridgeManagerOptions {
  editorEndpoint: Endpoint;
  runtimeDir: string;
  projectPath: string | null;
  timeoutMs: number;
  events: EventRing;
}

interface GameInstance {
  client: BridgeClient;
  hello: Hello;
  key: string;
}

// Minimal shape of a spawned editor process (structurally satisfied by
// node:child_process ChildProcess), so gd_editor_quit can confirm exit and
// kill as a fallback without coupling the manager to the spawn site.
export interface EditorProcess {
  pid?: number;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: (...args: unknown[]) => void): unknown;
}

function log(message: string): void {
  process.stderr.write(`conduit-broker: ${message}\n`);
}

function normalizeProjectPath(path: string): string {
  // Same canonicalisation both ends use to derive the endpoint hash, so a
  // project-path match here agrees with endpoint discovery.
  return canonicalProjectKey(path);
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
  // Single-flight guards: one editor connect attempt and one endpoint scan at a
  // time. Two BridgeClients racing one endpoint is fatal on Windows, where a
  // bridge pipe serves one client at a time (docs/api-gaps.md).
  private connecting = false;
  private scanning = false;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private editorProcess: EditorProcess | null = null;

  constructor(private readonly options: BridgeManagerOptions) {}

  async connectEditor(retryMs = 10_000): Promise<Hello> {
    return this.ensureEditorConnected(retryMs);
  }

  /** Return the current editor hello, connecting (with retries) if needed. */
  async ensureEditorConnected(timeoutMs: number): Promise<Hello> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = "no attempt made";
    do {
      if (this.editor && this.editorHello) {
        return this.editorHello;
      }
      if (!this.connecting) {
        try {
          return await this.attemptEditorConnect();
        } catch (error) {
          lastError = error;
        }
      }
      await sleep(300);
    } while (Date.now() < deadline);
    throw new BridgeError({
      code: "editor_unavailable",
      message: `could not connect to the editor bridge at ${endpointKey(this.options.editorEndpoint)}: ${String(lastError)}`,
      retryable: true,
    });
  }

  // One connect attempt, guarded so the background reconnect loop and a
  // foreground ensureEditorConnected never race two clients onto the endpoint.
  private async attemptEditorConnect(): Promise<Hello> {
    this.connecting = true;
    const client = new BridgeClient({ endpoint: this.options.editorEndpoint, defaultTimeoutMs: this.options.timeoutMs });
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
      this.options.events.record("editor_connected", { engine_version: hello.engine_version });
      return hello;
    } catch (error) {
      client.close();
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  // A broker restart or transient socket failure must not require restarting
  // Godot, and the editor may come up after the broker (gd_editor_launch), so
  // reconnection runs in the background for the broker's lifetime (section 7.5).
  startEditorReconnect(intervalMs = 2_000): void {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setInterval(() => {
      if (this.editor || this.connecting) {
        return;
      }
      this.attemptEditorConnect()
        .then((hello) => log(`editor bridge reconnected (engine ${hello.engine_version})`))
        .catch(() => {});
    }, intervalMs);
    this.reconnectTimer.unref?.();
  }

  // Adopt game bridges that appear without gd_play: launched externally with
  // the opt-in flag, per section 7.5. This loop and waitForGame share scanOnce,
  // the single owner of endpoint connection attempts.
  startGameDiscovery(intervalMs = 1_000): void {
    if (this.discoveryTimer) {
      return;
    }
    this.discoveryTimer = setInterval(() => {
      void this.scanOnce();
    }, intervalMs);
    this.discoveryTimer.unref?.();
  }

  stopBackground(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
  }

  isEditorConnected(): boolean {
    return this.editor != null;
  }

  setEditorProcess(proc: EditorProcess | null): void {
    this.editorProcess = proc;
  }

  getEditorProcess(): EditorProcess | null {
    return this.editorProcess;
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

  /** Pids of currently connected game instances (snapshot for waitForGame). */
  knownGamePids(): Set<number> {
    return new Set(this.games.keys());
  }

  // Wait for a game instance beyond the excluded set to connect. Scanning stays
  // single-flight through scanOnce, so this never races the discovery loop onto
  // an endpoint; it only accelerates the poll while a caller is waiting.
  async waitForGame(timeoutMs: number, exclude?: Set<number>): Promise<GameInstance> {
    const known = exclude ?? this.knownGamePids();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.scanOnce();
      for (const [pid, instance] of this.games) {
        if (!known.has(pid)) {
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

  // The single owner of game endpoint connection attempts: no-op while another
  // scan is in flight.
  private async scanOnce(): Promise<void> {
    if (this.scanning) {
      return;
    }
    this.scanning = true;
    try {
      for (const endpoint of this.newGameEndpoints()) {
        await this.tryConnectGame(endpoint);
      }
    } finally {
      this.scanning = false;
    }
  }

  // Endpoints of game bridges advertised since we last looked, scoped to this
  // project (needed on Windows, where the pipe namespace is process-global) and
  // excluding ones already connected.
  private newGameEndpoints(): Endpoint[] {
    const hash = this.options.projectPath
      ? projectHash(this.options.projectPath)
      : undefined;
    return listGameTokens(this.options.runtimeDir, hash)
      .map((token) => gameEndpointFromToken(this.options.runtimeDir, token))
      .filter((endpoint) => !this.connectedSockets.has(endpointKey(endpoint)));
  }

  private async tryConnectGame(endpoint: Endpoint): Promise<GameInstance | null> {
    const key = endpointKey(endpoint);
    const client = new BridgeClient({ endpoint, defaultTimeoutMs: this.options.timeoutMs });
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

      const instance: GameInstance = { client, hello, key };
      client.onEvent = (event) => this.options.events.record(event.event, { ...(event.data as object), pid: hello.pid });
      client.onClose = () => this.handleGameClose(hello.pid, key);

      this.games.set(hello.pid, instance);
      this.currentPid = hello.pid;
      this.connectedSockets.add(key);
      this.options.events.record("game_started", { pid: hello.pid, engine_version: hello.engine_version });
      log(`game bridge connected (pid ${hello.pid}, engine ${hello.engine_version})`);
      return instance;
    } catch (error) {
      // The endpoint may exist before the game finishes binding; leave it for the
      // next poll rather than marking it connected.
      log(`game endpoint ${key} not ready yet: ${String(error)}`);
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

  private handleGameClose(pid: number, key: string): void {
    this.games.delete(pid);
    this.connectedSockets.delete(key);
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
