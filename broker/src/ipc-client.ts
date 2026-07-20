// Connects to a Conduit bridge over a local socket, frames requests, and
// correlates responses by monotonically increasing id with per-request
// timeouts (whitepaper sections 6.4 correlation and 7.5 lifecycle).

import net from "node:net";

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

interface BridgeResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: BridgeErrorPayload;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BridgeClientOptions {
  socketPath: string;
  defaultTimeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

export class BridgeClient {
  private socket: net.Socket | null = null;
  private readonly parser = new FrameParser();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly socketPath: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: BridgeClientOptions) {
    this.socketPath = options.socketPath;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      socket.once("connect", () => {
        this.socket = socket;
        resolve();
      });
      socket.once("error", (error) => reject(error));
      socket.on("data", (chunk: Buffer) => this.onData(chunk));
      socket.on("close", () => this.onClose());
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
      let response: BridgeResponse;
      try {
        response = JSON.parse(frame.toString("utf8")) as BridgeResponse;
      } catch {
        continue;
      }
      this.settle(response);
    }
  }

  private settle(response: BridgeResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return; // stale or unknown id; ignore
    }
    this.pending.delete(response.id);
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

  private onClose(): void {
    this.failAll(new BridgeError({ code: "disconnected", message: "bridge connection closed", retryable: true }));
    this.socket = null;
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

  close(): void {
    this.failAll(new BridgeError({ code: "disconnected", message: "client closed", retryable: true }));
    this.socket?.destroy();
    this.socket = null;
  }
}
