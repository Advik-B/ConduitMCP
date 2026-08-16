// Owns the persistent editor bridge connection and the on-demand game bridge
// connections, discovers game sockets after gd_play, checks the protocol
// version at the handshake, and turns a game socket closing into a game_exited
// event (whitepaper sections 6.1, 7.2, and 7.5).

import { setTimeout as sleep } from "node:timers/promises";

import {
  type Endpoint,
  endpointKey,
  gameEndpointFromToken,
  listEditorTokens,
  listGameTokens,
  projectHash,
  tcpEnabled,
} from "./endpoint.ts";
import { canonicalProjectKey } from "./framing.ts";
import { BridgeClient, BridgeError, type Hello } from "./ipc-client.ts";
import type { EventRing } from "./events.ts";

export const PROTOCOL_VERSION = 1;

const ENDPOINT_BACKOFF_BASE_MS = 250;
const ENDPOINT_BACKOFF_MAX_MS = 30_000;
// The editor backs off far less than a game endpoint. A game socket that will
// not answer is one of many and is usually a corpse; the editor endpoint is the
// only one the broker has, and "accepted but no hello yet" is also what a cold
// editor looks like while it imports before its extension settles. Waiting half
// a minute to try that again would turn a slow start into a dead session.
const EDITOR_BACKOFF_MAX_MS = 5_000;

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
  // Backoff and log suppression for the editor endpoint. Unlike a game endpoint
  // this key never changes, so the state lives in fields rather than in
  // endpointBackoff, and only the expensive failure shape backs off; see
  // noteEditorFailure.
  private editorBackoffUntil = 0;
  private editorAttempts = 0;
  private editorQuiet = false;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private editorProcess: EditorProcess | null = null;
  // Backoff for game endpoints that fail to connect. A .sock left behind by a
  // SIGKILLed game is never cleaned up by its owner and would otherwise be
  // retried every poll for the broker's lifetime, one stderr line each time.
  // Unlinking it is not an option: the file may belong to a live process the
  // broker simply cannot reach yet.
  private readonly endpointBackoff = new Map<string, { until: number; attempts: number; capped: boolean }>();

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
      message: `could not connect to the editor bridge at ${endpointKey(this.options.editorEndpoint)}: ${String(lastError)}. ${this.editorHint()}`,
      retryable: true,
    });
  }

  /**
   * Why the derived editor endpoint is not answering, in terms of what is
   * actually advertised. The endpoint hash is one-way, so an endpoint cannot be
   * mapped back to a project without connecting, and connecting to someone
   * else's editor is not safe: on Windows a bridge pipe serves one client at a
   * time. Counting tokens is the most that can be said without probing, and it
   * distinguishes the two failures users actually hit.
   */
  editorHint(): string {
    if (tcpEnabled()) {
      return "endpoint scanning is unavailable under CONDUIT_TCP, so the broker cannot tell whether an editor is running";
    }
    const ourToken = this.options.projectPath ? `conduit-editor-${projectHash(this.options.projectPath)}` : null;
    const tokens = listEditorTokens(this.options.runtimeDir);
    if (ourToken && tokens.includes(ourToken)) {
      return "an editor endpoint for this project exists but is not accepting a connection; it may still be starting, or another broker already holds it (a bridge serves one client at a time)";
    }
    if (tokens.length === 0) {
      return "no Godot editor is advertising a Conduit endpoint; open the project in Godot and confirm the addon is installed under addons/conduit";
    }
    const project = this.options.projectPath ?? "(none configured)";
    return `${tokens.length} editor bridge(s) are running, none of them for ${project}; check that --project names the same folder that is open in Godot`;
  }

  // One connect attempt, guarded so the background reconnect loop and a
  // foreground ensureEditorConnected never race two clients onto the endpoint.
  private async attemptEditorConnect(): Promise<Hello> {
    this.connecting = true;
    const client = new BridgeClient({ endpoint: this.options.editorEndpoint, defaultTimeoutMs: this.options.timeoutMs });
    let connected = false;
    try {
      await client.connect();
      connected = true;
      const hello = await client.waitForHello(5_000);
      checkProtocol(hello);
      client.onEvent = (event) => this.handleEditorEvent(event);
      client.onClose = () => {
        this.editor = null;
        this.options.events.record("editor_disconnected", {});
      };
      // From here the link is ours, so start asking whether it is still alive.
      // The reconnect loop below picks it up again when liveness drops it.
      client.startLiveness();
      this.editor = client;
      this.editorHello = hello;
      // Resync break state: events emitted while the broker was disconnected
      // are dropped bridge-side, so read the current state once on connect.
      void this.resyncDebugState();
      this.options.events.record("editor_connected", { engine_version: hello.engine_version });
      return hello;
    } catch (error) {
      client.close();
      // Accepted the socket, then no hello inside the timeout. The listener
      // serves one client at a time on every transport (bridge accept loops in
      // bridge/src/transport/ipc.rs), so the connection sits in the backlog
      // unanswered while another broker is being served. Naming that is the
      // difference between a silent stall and something a user can act on; it
      // is the usual cause when a second MCP server entry is configured for a
      // project that already has one.
      if (connected && error instanceof BridgeError && error.code === "timeout") {
        throw new BridgeError({
          code: "editor_busy",
          message: `the editor bridge at ${endpointKey(this.options.editorEndpoint)} accepted the connection but sent no hello frame; a bridge serves one broker at a time, so another broker or a second MCP server entry for this project is probably already attached to it`,
          retryable: true,
        });
      }
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
    const attempt = (): void => {
      if (this.editor || this.connecting || Date.now() < this.editorBackoffUntil) {
        return;
      }
      this.attemptEditorConnect()
        .then((hello) => {
          this.editorBackoffUntil = 0;
          this.editorAttempts = 0;
          this.editorQuiet = false;
          log(`editor bridge connected (engine ${hello.engine_version})`);
        })
        .catch((error: unknown) => this.noteEditorFailure(error));
    };
    // Immediately, not one interval from now. This loop is the only thing that
    // connects the editor at startup, so deferring the first attempt would leave
    // an already-running editor unattached for the first tool calls a client
    // makes after the handshake.
    attempt();
    this.reconnectTimer = setInterval(attempt, intervalMs);
    this.reconnectTimer.unref?.();
  }

  /**
   * Record a failed editor connection, deciding whether to slow down and whether
   * to say anything.
   *
   * The two failure shapes cost very different amounts. A bridge that is not
   * there refuses instantly, so retrying every interval is free and the only
   * thing worth suppressing is a log line every two seconds for the broker's
   * lifetime. A bridge that accepts and then never says hello costs a full
   * five-second timeout per attempt and, worse, holds the listener's single
   * accept slot for that whole time, which is exactly the slot the incumbent
   * broker needs to reconnect through. That one backs off geometrically.
   */
  private noteEditorFailure(error: unknown): void {
    if (error instanceof BridgeError && error.code === "editor_busy") {
      // Counted only here, so the delay reflects consecutive busy attempts. A
      // shared counter would let a long absence push the very first busy attempt
      // straight to the cap.
      this.editorAttempts += 1;
      const delayMs = Math.min(2 ** this.editorAttempts * ENDPOINT_BACKOFF_BASE_MS, EDITOR_BACKOFF_MAX_MS);
      this.editorBackoffUntil = Date.now() + delayMs;
      if (!this.editorQuiet) {
        this.editorQuiet = true;
        log(`${error.message}; retrying quietly, at most every ${Math.round(EDITOR_BACKOFF_MAX_MS / 1000)}s`);
      }
      return;
    }
    if (!this.editorQuiet) {
      this.editorQuiet = true;
      log(`editor bridge not available yet; continuing without it. ${this.editorHint()}`);
    }
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

  /**
   * Release every bridge connection, for a broker that is going away.
   *
   * Letting process exit do this is not good enough. A bridge serves one client
   * at a time, so until these sockets close the engine keeps the accept slot
   * assigned to a broker that is leaving, and the next one to start cannot
   * attach. Closing here makes that handover immediate rather than dependent on
   * the peer noticing.
   */
  shutdown(): void {
    this.stopBackground();
    this.editor?.close();
    this.editor = null;
    for (const instance of this.games.values()) {
      instance.client.close();
    }
    this.games.clear();
    this.connectedSockets.clear();
    this.currentPid = null;
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
    const now = Date.now();
    return listGameTokens(this.options.runtimeDir, hash)
      .map((token) => gameEndpointFromToken(this.options.runtimeDir, token))
      .filter((endpoint) => {
        const key = endpointKey(endpoint);
        if (this.connectedSockets.has(key)) {
          return false;
        }
        const backoff = this.endpointBackoff.get(key);
        return !backoff || backoff.until <= now;
      });
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
      // A game that stops answering is reported as exited through the same path
      // as one whose socket closed; discovery re-adopts it if it comes back.
      client.startLiveness();

      this.games.set(hello.pid, instance);
      this.currentPid = hello.pid;
      this.connectedSockets.add(key);
      this.endpointBackoff.delete(key);
      this.options.events.record("game_started", { pid: hello.pid, engine_version: hello.engine_version });
      log(`game bridge connected (pid ${hello.pid}, engine ${hello.engine_version})`);
      return instance;
    } catch (error) {
      // The endpoint may exist before the game finishes binding, so it is left
      // for a later poll rather than marked connected. Back off geometrically
      // so a socket whose owner is gone stops costing an attempt and a log line
      // every second, and go quiet once the delay reaches its cap.
      const previous = this.endpointBackoff.get(key);
      const attempts = (previous?.attempts ?? 0) + 1;
      const delayMs = Math.min(2 ** attempts * ENDPOINT_BACKOFF_BASE_MS, ENDPOINT_BACKOFF_MAX_MS);
      const capped = delayMs >= ENDPOINT_BACKOFF_MAX_MS;
      this.endpointBackoff.set(key, { until: Date.now() + delayMs, attempts, capped });
      if (!capped) {
        log(`game endpoint ${key} not ready yet, retrying in ${delayMs}ms: ${String(error)}`);
      } else if (!previous?.capped) {
        log(`game endpoint ${key} unreachable after ${attempts} attempts; slowing to one attempt every ${ENDPOINT_BACKOFF_MAX_MS / 1000}s and no longer logging it`);
      }
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
    this.endpointBackoff.delete(key);
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
    const connected = this.editor != null;
    return {
      editor: {
        connected,
        engine_version: this.editorHello?.engine_version ?? null,
        protocol_version: this.editorHello?.protocol_version ?? null,
        endpoint: endpointKey(this.options.editorEndpoint),
        // Only computed when it can help: the hint reads the runtime directory.
        hint: connected ? null : this.editorHint(),
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
