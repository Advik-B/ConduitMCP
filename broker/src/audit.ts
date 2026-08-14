// Append-only JSONL audit log of every tool call (whitepaper section 9).
//
// It exists for the human's review and for replaying or bisecting an agent
// session after the fact, so it records what was asked, what came back, and how
// long it took. It is local, size-rotated, and off unless a path is given.
//
// Two properties are load-bearing. Large payloads are elided per field rather
// than by thresholding the serialized record: gd_screenshot returns megabytes of
// base64, and thresholding the whole record would drop the outcome and the error
// code, which is the part worth keeping. And a write failure never propagates: a
// broker that dies because its audit log filled a disk is worse than one that
// stops auditing and says so.

import fs from "node:fs";
import path from "node:path";

/** Strings longer than this are replaced by a placeholder naming their size. */
const ELIDE_OVER_BYTES = 4096;

export interface AuditRecord {
  time: string;
  tool: string;
  args: unknown;
  outcome: "ok" | "error";
  error?: string;
  result: unknown;
  duration_ms: number;
}

function elideString(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes > ELIDE_OVER_BYTES ? `<elided ${bytes} bytes>` : value;
}

/**
 * Deep-copy a value, replacing oversized strings with a placeholder. Arrays and
 * plain objects are walked so a screenshot's `data` field is elided while the
 * `type` beside it survives.
 */
export function elide(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return elideString(value);
  }
  if (value === null || typeof value !== "object" || depth > 8) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => elide(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = elide(item, depth + 1);
  }
  return out;
}

/**
 * Summarise a tool result for the log: the content entries with their payloads
 * elided, plus the error text when the call failed. `isError` is what MCP uses
 * to signal failure, and the leading `code:` of the text is the structured error
 * model of whitepaper section 7.4.
 */
export function summarizeResult(result: unknown): { outcome: "ok" | "error"; error?: string; result: unknown } {
  const shaped = result as { content?: Array<Record<string, unknown>>; isError?: boolean } | null;
  const content = Array.isArray(shaped?.content) ? (elide(shaped.content) as Array<Record<string, unknown>>) : undefined;
  if (shaped?.isError) {
    const first = content?.[0];
    const text = typeof first?.text === "string" ? first.text : "";
    return { outcome: "error", error: text, result: content ?? null };
  }
  return { outcome: "ok", result: content ?? elide(result) };
}

export class AuditLog {
  private bytes = 0;
  private disabled = false;

  constructor(
    private readonly file: string,
    private readonly maxBytes: number,
    private readonly onDisable: (reason: string) => void = () => {},
  ) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    } catch (error) {
      this.disable(error);
    }
  }

  get path(): string {
    return this.file;
  }

  get enabled(): boolean {
    return !this.disabled;
  }

  private disable(error: unknown): void {
    if (this.disabled) {
      return;
    }
    this.disabled = true;
    this.onDisable(`audit log ${this.file} disabled: ${error instanceof Error ? error.message : String(error)}`);
  }

  // One generation kept: the point is a bounded window of recent history, not
  // an archive. Renaming onto an existing .1 replaces it.
  private rotateIfNeeded(incoming: number): void {
    if (this.bytes + incoming <= this.maxBytes) {
      return;
    }
    const previous = `${this.file}.1`;
    fs.rmSync(previous, { force: true });
    fs.renameSync(this.file, previous);
    this.bytes = 0;
  }

  /** Record one completed tool call. Never throws. */
  record(tool: string, args: unknown, result: unknown, durationMs: number): void {
    if (this.disabled) {
      return;
    }
    try {
      const summary = summarizeResult(result);
      const entry: AuditRecord = {
        time: new Date().toISOString(),
        tool,
        args: elide(args),
        outcome: summary.outcome,
        ...(summary.error !== undefined ? { error: summary.error } : {}),
        result: summary.result,
        duration_ms: Math.round(durationMs),
      };
      const line = `${JSON.stringify(entry)}\n`;
      const size = Buffer.byteLength(line, "utf8");
      this.rotateIfNeeded(size);
      fs.appendFileSync(this.file, line);
      this.bytes += size;
    } catch (error) {
      this.disable(error);
    }
  }
}
