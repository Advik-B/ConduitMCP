// Length-prefixed JSON framing for the broker-to-bridge protocol
// (whitepaper section 7.2): a 4-byte big-endian length then that many UTF-8
// JSON bytes. This module is pure and has no socket dependency so it is unit
// tested directly.

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function encodeFrame(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

// Accumulates bytes across reads and yields complete frame payloads as they
// arrive. Mirrors the Rust FrameDecoder so both ends agree on the wire format.
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new Error(`frame length ${length} exceeds maximum ${MAX_FRAME_BYTES}`);
      }
      if (this.buffer.length < 4 + length) {
        break;
      }
      frames.push(this.buffer.subarray(4, 4 + length));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return frames;
  }
}

// Canonicalise a project path so the broker and the bridge derive the same
// endpoint hash from it. Must match the Rust `canonical_project_key`: forward
// slashes, no trailing slash, and case-folded on Windows (its filesystem is
// case-insensitive, so `globalize_path` and CONDUIT_PROJECT can disagree on
// drive-letter case).
export function canonicalProjectKey(input: string): string {
  let key = input.replace(/\\/g, "/");
  while (key.length > 1 && key.endsWith("/")) {
    key = key.slice(0, -1);
  }
  // Case-fold on case-insensitive filesystems (Windows, and macOS by default),
  // matching the Rust canonical_project_key so both ends derive the same hash.
  if (process.platform === "win32" || process.platform === "darwin") {
    key = key.toLowerCase();
  }
  return key;
}

// FNV-1a over the project path, low 32 bits as 8 hex chars. Must match the
// Rust `short_hash` so both ends derive the same default endpoint name.
export function shortHash(input: string): string {
  let hash = 0xcbf29ce4_84222325n;
  const mask = 0xffffffffffffffffn;
  for (const byte of Buffer.from(input, "utf8")) {
    hash = (hash ^ BigInt(byte)) & mask;
    hash = (hash * 0x00000100000001b3n) & mask;
  }
  const low = hash & 0xffffffffn;
  return low.toString(16).padStart(8, "0");
}
