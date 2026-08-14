import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";

import { isSafeEntryName, readZip, ZipError } from "../src/zip.ts";

// A zip writer, so the reader is exercised against bytes rather than a fixture
// checked into the tree. Store and deflate are the only methods
// scripts/package-addon.ts ever produces.
function buildZip(entries: Array<{ name: string; data: Buffer; store?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = entry.store ? entry.data : deflateRawSync(entry.data);
    const method = entry.store ? 0 : 8;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);
  return Buffer.concat([localBlock, centralBlock, eocd]);
}

describe("readZip", () => {
  test("round-trips deflated and stored entries", () => {
    const big = Buffer.from("conduit ".repeat(4096), "utf8");
    const zip = buildZip([
      { name: "addons/conduit/conduit.gdextension", data: Buffer.from("[configuration]\n", "utf8") },
      { name: "addons/conduit/bin/libconduit.so", data: big },
      { name: "addons/conduit/LICENSE", data: Buffer.from("MIT", "utf8"), store: true },
    ]);

    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual([
      "addons/conduit/conduit.gdextension",
      "addons/conduit/bin/libconduit.so",
      "addons/conduit/LICENSE",
    ]);
    expect(entries[1]?.data.equals(big)).toBe(true);
    expect(entries[2]?.data.toString("utf8")).toBe("MIT");
  });

  test("skips directory entries", () => {
    const zip = buildZip([
      { name: "addons/conduit/", data: Buffer.alloc(0), store: true },
      { name: "addons/conduit/LICENSE", data: Buffer.from("MIT", "utf8"), store: true },
    ]);
    expect(readZip(zip).map((e) => e.name)).toEqual(["addons/conduit/LICENSE"]);
  });

  // PowerShell Compress-Archive has shipped backslash separators; normalising
  // before anything else is what keeps the traversal check meaningful.
  test("normalises backslash separators", () => {
    const zip = buildZip([{ name: "addons\\conduit\\LICENSE", data: Buffer.from("MIT", "utf8"), store: true }]);
    expect(readZip(zip)[0]?.name).toBe("addons/conduit/LICENSE");
  });

  test("rejects a buffer that is not a zip", () => {
    expect(() => readZip(Buffer.from("not a zip at all", "utf8"))).toThrow(ZipError);
  });
});

describe("isSafeEntryName", () => {
  test("accepts ordinary relative paths", () => {
    expect(isSafeEntryName("addons/conduit/bin/conduit.dll")).toBe(true);
  });

  test("rejects traversal, absolute paths, and drive letters", () => {
    expect(isSafeEntryName("../outside")).toBe(false);
    expect(isSafeEntryName("addons/../../outside")).toBe(false);
    expect(isSafeEntryName("/etc/passwd")).toBe(false);
    expect(isSafeEntryName("C:/Windows/system32")).toBe(false);
    expect(isSafeEntryName("addons//conduit")).toBe(false);
    expect(isSafeEntryName("")).toBe(false);
  });
});
