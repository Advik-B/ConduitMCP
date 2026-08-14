// Minimal zip reader for the addon installer.
//
// The published broker is a single bundle targeting stock Node
// (scripts/pack-npm.ts), so Bun's archive helpers are unavailable and shelling
// out to unzip or Expand-Archive from an MCP server is fragile. The only
// archives read here are ones this project produces (scripts/package-addon.ts),
// which means store and deflate, no zip64 and no encryption. Keeping it in
// tree also preserves the package's deliberate zero-dependency manifest.

import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
// The EOCD record is 22 bytes plus a comment of up to 64 KiB.
const MAX_EOCD_SEARCH = 22 + 0xffff;

export interface ZipEntry {
  /** Entry name with separators normalised to forward slashes. */
  name: string;
  data: Buffer;
}

export class ZipError extends Error {}

// Zip stores paths with forward slashes, but not every writer obeys: PowerShell
// Compress-Archive has shipped backslashes. Normalise before anything else, or
// a whole path arrives as one filename and the traversal check below is
// inspecting the wrong string.
function normalizeName(raw: string): string {
  return raw.replace(/\\/g, "/");
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let offset = buffer.length - 22; offset >= start; offset--) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  throw new ZipError("not a zip archive: no end-of-central-directory record");
}

function decompress(method: number, compressed: Buffer, expectedSize: number, name: string): Buffer {
  let data: Buffer;
  if (method === 0) {
    data = compressed;
  } else if (method === 8) {
    data = inflateRawSync(compressed);
  } else {
    throw new ZipError(`unsupported compression method ${method} for ${name}`);
  }
  if (data.length !== expectedSize) {
    throw new ZipError(`${name} inflated to ${data.length} bytes, expected ${expectedSize}`);
  }
  return data;
}

/**
 * Read every file entry from a zip buffer. Directory entries (trailing slash,
 * zero length) are skipped: the extractor creates directories from file paths.
 */
export function readZip(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) {
    throw new ZipError("zip64 archives are not supported");
  }

  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new ZipError(`corrupt central directory at entry ${index}`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = normalizeName(buffer.toString("utf8", offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) {
      continue;
    }
    if (buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
      throw new ZipError(`corrupt local header for ${name}`);
    }
    // The local header repeats the name and extra fields with its own lengths;
    // the extra field in particular routinely differs from the central copy.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.push({ name, data: decompress(method, compressed, uncompressedSize, name) });
  }
  return entries;
}

/**
 * Whether an entry name is safe to join onto a destination directory: relative,
 * with no traversal segment and no drive letter. Applied to every entry before
 * anything is written, so a hostile archive cannot escape the staging root.
 */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
    return false;
  }
  return !name.split("/").some((segment) => segment === ".." || segment === "");
}
