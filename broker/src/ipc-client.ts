// Connects to a Conduit bridge over a local socket, frames requests, and
// correlates responses by monotonically increasing id with per-request
// timeouts (whitepaper sections 6.4 correlation and 7.5 lifecycle).
//
// Two id-less frame shapes arrive unsolicited: the hello frame the bridge
// writes first on every connection, and event frames. Everything else is an
// id-correlated response.

import net from "node:net";

import type { Endpoint } from "./endpoint.ts";
import { endpointKey } from "./endpoint.ts";
import { encodeFrame, FrameParser } from "./framing.ts";

export interface BridgeErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
}

export class BridgeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(payload: BridgeErrorPayload) {
    super(payload.message);
    this.name = "BridgeError";
    this.code = payload.code;
    this.retryable = payload.retryable;
  }
}

export interface Hello {
  role: "editor" | "game";
  protocol_version: number;
  bridge_version: string;
  engine_version: string;
  project_path: string;
  pid: number;
}

export interface BridgeEvent {
  event: string;
  data?: unknown;
}

interface BridgeResponse {
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: BridgeErrorPayload;
  hello?: Hello;
  event?: string;
  data?: unknown;
  ping?: number;
  pong?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BridgeClientOptions {
  endpoint: Endpoint;
  defaultTimeoutMs?: number;
}

// A last-resort fallback for a client constructed without options, which only
// tests do. The running broker always passes the configured value
// (--timeout-ms) down through BridgeManager, so this is not the live default.
export const DEFAULT_TIMEOUT_MS = 10_000;

// Liveness, mirroring bridge/src/transport/ipc.rs. A socket staying open proves
// only that some process holds the descriptor: a suspended engine, a half-open
// connection, or a descriptor inherited by a child all leave a link that will
// never answer but never closes either. Between tool calls nothing else would
// notice, so the client asks.
export const PING_AFTER_MS = 5_000;
export const LIVENESS_TIMEOUT_MS = 20_000;

/** Liveness timings, overridable only so tests need not wait out the real ones. */
export interface LivenessOptions {
  pingAfterMs?: number;
  timeoutMs?: number;
  intervalMs?: number;
}

export class BridgeClient {
  private socket: net.Socket | null = null;
  private readonly parser = new FrameParser();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly endpoint: Endpoint;
  private readonly defaultTimeoutMs: number;

  private hello: Hello | null = null;
  private readonly helloWaiters: Array<(hello: Hello) => void> = [];

  // Liveness state. `armed` gates the deadline on having seen a pong, so a
  // bridge too old to know the frame is never disconnected for speaking the
  // protocol it was built against; it degrades to close-only detection.
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private lastRx = Date.now();
  private lastPing = 0;
  private pingSeq = 0;
  private armed = false;
  private silent = false;

  onEvent: ((event: BridgeEvent) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(options: BridgeClientOptions) {
    this.endpoint = options.endpoint;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** A stable string identifier for this client's endpoint, for logs and tracking. */
  endpointId(): string {
    return endpointKey(this.endpoint);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // net.createConnection takes a path/pipe string or a {host,port} object.
      const socket =
        typeof this.endpoint === "string"
          ? net.createConnection(this.endpoint)
          : net.createConnection(this.endpoint.port, this.endpoint.host);
      socket.once("connect", () => {
        this.socket = socket;
        resolve();
      });
      socket.once("error", (error) => reject(error));
      socket.on("data", (chunk: Buffer) => this.onData(chunk));
      socket.on("close", () => this.handleClose());
    });
  }

  /// Resolve with the bridge's hello frame, waiting up to `timeoutMs` for it.
  waitForHello(timeoutMs = 5_000): Promise<Hello> {
    if (this.hello) {
      return Promise.resolve(this.hello);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new BridgeError({ code: "timeout", message: "no hello frame from bridge", retryable: true }));
      }, timeoutMs);
      this.helloWaiters.push((hello) => {
        clearTimeout(timer);
        resolve(hello);
      });
    });
  }

  private onData(chunk: Buffer): void {
    // Any inbound byte proves the bridge is acting, so a busy link is never
    // pinged; only genuine silence is.
    this.lastRx = Date.now();
    this.lastPing = 0;
    let frames: Buffer[];
    try {
      frames = this.parser.push(chunk);
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
      this.socket?.destroy();
      return;
    }
    for (const frame of frames) {
      let message: BridgeResponse;
      try {
        message = JSON.parse(frame.toString("utf8")) as BridgeResponse;
      } catch {
        continue;
      }
      // Liveness frames are answered here rather than as a tool: the pong must
      // say the broker's event loop is turning without depending on the engine,
      // the agent, or anything the MCP layer is doing.
      if (typeof message.ping === "number") {
        this.socket?.write(encodeFrame({ pong: message.ping }));
      } else if (typeof message.pong === "number") {
        this.armed = true;
      } else if (message.hello) {
        this.setHello(message.hello);
      } else if (typeof message.event === "string") {
        this.onEvent?.({ event: message.event, data: message.data });
      } else if (typeof message.id === "number") {
        this.settle(message);
      }
    }
  }

  /**
   * Ask, and stop believing in a bridge that will not answer.
   *
   * Started once the hello has arrived, because before that there is nothing to
   * be silent about, and cleared in close(). The interval is unref'd like the
   * manager's loops so it never holds the process open by itself.
   */
  startLiveness(options: LivenessOptions = {}): void {
    if (this.liveTimer) {
      return;
    }
    // Injectable so tests assert the behaviour in milliseconds instead of
    // waiting out the shipped budget; the broker always takes the defaults.
    const pingAfterMs = options.pingAfterMs ?? PING_AFTER_MS;
    const timeoutMs = options.timeoutMs ?? LIVENESS_TIMEOUT_MS;
    const intervalMs = options.intervalMs ?? Math.max(50, Math.floor(pingAfterMs / 5));
    this.liveTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket) {
        return;
      }
      const silentFor = Date.now() - this.lastRx;
      if (this.armed && silentFor >= timeoutMs) {
        this.silent = true;
        this.close();
        return;
      }
      // One ping per interval rather than one per tick.
      if (silentFor >= pingAfterMs && Date.now() - this.lastPing >= pingAfterMs) {
        this.lastPing = Date.now();
        this.pingSeq += 1;
        socket.write(encodeFrame({ ping: this.pingSeq }));
      }
    }, intervalMs);
    this.liveTimer.unref?.();
  }

  private setHello(hello: Hello): void {
    this.hello = hello;
    const waiters = this.helloWaiters.splice(0);
    for (const waiter of waiters) {
      waiter(hello);
    }
  }

  private settle(response: BridgeResponse): void {
    const pending = this.pending.get(response.id!);
    if (!pending) {
      return; // stale or unknown id; ignore
    }
    this.pending.delete(response.id!);
    clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      const payload = response.error ?? {
        code: "internal_error",
        message: "response marked not ok without an error body",
        retryable: false,
      };
      pending.reject(new BridgeError(payload));
    }
  }

  private handleClose(): void {
    this.failAll(new BridgeError({ code: "disconnected", message: this.closeReason(), retryable: true }));
    this.socket = null;
    this.stopLiveness();
    this.onClose?.();
  }

  /** Why a pending call is failing, so a silent peer is not reported as an
   * ordinary disconnection the user cannot act on. */
  private closeReason(): string {
    return this.silent
      ? "the bridge stopped responding: it went silent and did not answer a liveness ping, so the connection was dropped; the engine may be suspended or wedged"
      : "bridge connection closed";
  }

  private stopLiveness(): void {
    if (this.liveTimer) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(
        new BridgeError({ code: "disconnected", message: "not connected to a bridge", retryable: true }),
      );
    }
    const id = this.nextId++;
    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError({ code: "timeout", message: `request ${id} (${tool}) timed out`, retryable: true }));
      }, effectiveTimeout);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(encodeFrame({ id, tool, args }));
    });
  }

  helloInfo(): Hello | null {
    return this.hello;
  }

  isConnected(): boolean {
    return this.socket !== null;
  }

  close(): void {
    this.stopLiveness();
    this.failAll(new BridgeError({ code: "disconnected", message: this.silent ? this.closeReason() : "client closed", retryable: true }));
    this.socket?.destroy();
    this.socket = null;
  }
}
