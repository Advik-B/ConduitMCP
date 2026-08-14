import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AuditLog, elide, summarizeResult } from "../src/audit.ts";

const temporaries: string[] = [];

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conduit-audit-test-"));
  temporaries.push(dir);
  return path.join(dir, "audit.jsonl");
}

function readLines(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const big = "x".repeat(9000);

describe("elide", () => {
  test("replaces oversized strings and keeps their neighbours", () => {
    const elided = elide({ content: [{ type: "image", data: big, mimeType: "image/png" }] }) as {
      content: Array<Record<string, unknown>>;
    };
    expect(elided.content[0]?.data).toBe("<elided 9000 bytes>");
    expect(elided.content[0]?.type).toBe("image");
    expect(elided.content[0]?.mimeType).toBe("image/png");
  });

  test("leaves small values and non-strings alone", () => {
    expect(elide({ a: "short", b: 3, c: null, d: [1, "two"] })).toEqual({ a: "short", b: 3, c: null, d: [1, "two"] });
  });
});

describe("summarizeResult", () => {
  test("an error result keeps its structured code, which is the point of the record", () => {
    const summary = summarizeResult({ content: [{ type: "text", text: "game_not_running: no game instance" }], isError: true });
    expect(summary.outcome).toBe("error");
    expect(summary.error).toContain("game_not_running");
  });

  // Thresholding the serialized record instead of the fields would drop the
  // error code along with the payload.
  test("a huge error payload still keeps a usable code", () => {
    const summary = summarizeResult({ content: [{ type: "text", text: `internal_error: ${big}` }], isError: true });
    expect(summary.outcome).toBe("error");
    expect(summary.error).toBe(`<elided ${big.length + "internal_error: ".length} bytes>`);
  });

  test("a success result is summarised without its payload", () => {
    const summary = summarizeResult({ content: [{ type: "image", data: big, mimeType: "image/png" }] });
    expect(summary.outcome).toBe("ok");
    expect(JSON.stringify(summary.result)).not.toContain("xxxx");
  });
});

describe("AuditLog", () => {
  test("writes one JSONL record per call with the spec'd fields", () => {
    const file = tempFile();
    const log = new AuditLog(file, 1024 * 1024);
    log.record("gd_ping", { a: 1 }, { content: [{ type: "text", text: "{}" }] }, 12.6);

    const lines = readLines(file);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: "gd_ping", outcome: "ok", duration_ms: 13, args: { a: 1 } });
    expect(typeof lines[0]?.time).toBe("string");
  });

  test("records failures with their error text", () => {
    const file = tempFile();
    const log = new AuditLog(file, 1024 * 1024);
    log.record("gd_play", {}, { content: [{ type: "text", text: "editor_unavailable: nope" }], isError: true }, 1);
    expect(lastRecord(file)).toMatchObject({ outcome: "error", error: "editor_unavailable: nope" });
  });

  test("no base64 payload reaches the file", () => {
    const file = tempFile();
    const log = new AuditLog(file, 1024 * 1024);
    log.record("gd_screenshot", {}, { content: [{ type: "image", data: big, mimeType: "image/png" }] }, 5);
    expect(fs.readFileSync(file, "utf8")).not.toContain("xxxxxxxx");
    expect(fs.statSync(file).size).toBeLessThan(1000);
  });

  test("rotates past the byte cap and keeps exactly one previous generation", () => {
    const file = tempFile();
    const log = new AuditLog(file, 400);
    for (let i = 0; i < 30; i++) {
      log.record(`gd_tool_${i}`, { i }, { content: [{ type: "text", text: "ok" }] }, 1);
    }
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.existsSync(`${file}.2`)).toBe(false);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(400);
    // The newest record survives rotation; the log is a recent window, not an archive.
    expect(lastRecord(file)).toMatchObject({ tool: "gd_tool_29" });
  });

  test("an unwritable path disables the log instead of throwing", () => {
    const reasons: string[] = [];
    // A file where a directory must be, so both mkdir and append fail.
    const blocker = tempFile();
    fs.writeFileSync(blocker, "not a directory");
    const log = new AuditLog(path.join(blocker, "nested", "audit.jsonl"), 1024, (reason) => reasons.push(reason));
    expect(log.enabled).toBe(false);
    expect(reasons).toHaveLength(1);
    expect(() => log.record("gd_ping", {}, { content: [] }, 1)).not.toThrow();
  });
});

function lastRecord(file: string): Record<string, unknown> {
  const lines = readLines(file);
  return lines[lines.length - 1] as Record<string, unknown>;
}
