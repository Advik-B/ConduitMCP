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

export const DEFAULT_TIMEOUT_MS = 10_000;

export class BridgeClient {
  private socket: net.Socket | null = null;
  private readonly parser = new FrameParser();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly endpoint: Endpoint;
  private readonly defaultTimeoutMs: number;

  private hello: Hello | null = null;
  private readonly helloWaiters: Array<(hello: Hello) => void> = [];

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
      if (message.hello) {
        this.setHello(message.hello);
      } else if (typeof message.event === "string") {
        this.onEvent?.({ event: message.event, data: message.data });
      } else if (typeof message.id === "number") {
        this.settle(message);
      }
    }
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
    this.failAll(new BridgeError({ code: "disconnected", message: "bridge connection closed", retryable: true }));
    this.socket = null;
    this.onClose?.();
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
    this.failAll(new BridgeError({ code: "disconnected", message: "client closed", retryable: true }));
    this.socket?.destroy();
    this.socket = null;
  }
}
