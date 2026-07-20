import { describe, expect, test } from "bun:test";

import { encodeFrame, FrameParser, MAX_FRAME_BYTES, shortHash } from "../src/framing.ts";

describe("framing", () => {
  test("encodeFrame prefixes a 4-byte big-endian length", () => {
    const frame = encodeFrame({ id: 1, tool: "gd_ping", args: {} });
    const length = frame.readUInt32BE(0);
    expect(length).toBe(frame.length - 4);
    const decoded = JSON.parse(frame.subarray(4).toString("utf8"));
    expect(decoded).toEqual({ id: 1, tool: "gd_ping", args: {} });
  });

  test("FrameParser reassembles frames split across chunks", () => {
    const a = encodeFrame({ id: 1 });
    const b = encodeFrame({ id: 2 });
    const combined = Buffer.concat([a, b]);

    const parser = new FrameParser();
    const collected: unknown[] = [];
    // Feed one byte at a time to prove partial-frame reassembly.
    for (const byte of combined) {
      for (const frame of parser.push(Buffer.from([byte]))) {
        collected.push(JSON.parse(frame.toString("utf8")));
      }
    }
    expect(collected).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("FrameParser yields multiple frames from one chunk", () => {
    const combined = Buffer.concat([encodeFrame({ id: 1 }), encodeFrame({ id: 2 })]);
    const parser = new FrameParser();
    const frames = parser.push(combined);
    expect(frames.length).toBe(2);
  });

  test("FrameParser rejects an oversized length prefix", () => {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    const parser = new FrameParser();
    expect(() => parser.push(header)).toThrow(/exceeds maximum/);
  });

  test("shortHash is stable, 8 hex chars, and project-specific", () => {
    expect(shortHash("/a/b/c")).toBe(shortHash("/a/b/c"));
    expect(shortHash("/a/b/c")).not.toBe(shortHash("/a/b/d"));
    expect(shortHash("/a/b/c")).toMatch(/^[0-9a-f]{8}$/);
  });
});
