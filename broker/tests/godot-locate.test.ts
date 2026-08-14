import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GodotResolver, resolveGodotBinary, searchedLocations } from "../src/godot-locate.ts";

const temporaries: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conduit-godot-test-"));
  temporaries.push(dir);
  return dir;
}

/** An executable named the way the platform's PATH lookup expects. */
function fakeGodot(dir: string, base = "godot"): string {
  const name = process.platform === "win32" ? `${base}.exe` : base;
  const full = path.join(dir, name);
  fs.writeFileSync(full, "#!/bin/sh\n");
  return full;
}

// Windows resolves through PATHEXT, whose entries are conventionally uppercase,
// so the returned extension case follows the variable rather than the file.
function samePath(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) {
    return false;
  }
  return process.platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// An env with no PATH and no platform install roots, so a test that expects
// "nothing found" is not defeated by a Godot the developer happens to have.
const EMPTY_ENV: NodeJS.ProcessEnv = {
  PATH: "",
  Path: "",
  PATHEXT: ".EXE",
  LOCALAPPDATA: path.join(os.tmpdir(), "conduit-absent-localappdata"),
  ProgramFiles: path.join(os.tmpdir(), "conduit-absent-programfiles"),
  "ProgramFiles(x86)": path.join(os.tmpdir(), "conduit-absent-programfiles86"),
};

describe("resolveGodotBinary", () => {
  test("an explicit path wins and is used verbatim", () => {
    const resolved = resolveGodotBinary("/somewhere/godot", EMPTY_ENV);
    expect(resolved).toEqual({ path: "/somewhere/godot", source: "configured" });
  });

  test("an explicit path is not validated, so a stale CONDUIT_GODOT still reports as configured", () => {
    expect(resolveGodotBinary("/does/not/exist", EMPTY_ENV)?.source).toBe("configured");
  });

  test("finds a binary on PATH", () => {
    const dir = tempDir();
    const binary = fakeGodot(dir);
    const resolved = resolveGodotBinary(null, { ...EMPTY_ENV, PATH: dir });
    expect(resolved?.source).toBe("path");
    expect(samePath(resolved?.path, binary)).toBe(true);
  });

  test("prefers godot4 over godot within one PATH entry", () => {
    const dir = tempDir();
    fakeGodot(dir, "godot");
    const versioned = fakeGodot(dir, "godot4");
    expect(samePath(resolveGodotBinary(null, { ...EMPTY_ENV, PATH: dir })?.path, versioned)).toBe(true);
  });

  test("searches PATH entries in order", () => {
    const first = tempDir();
    const second = tempDir();
    const binary = fakeGodot(first);
    fakeGodot(second);
    const resolved = resolveGodotBinary(null, { ...EMPTY_ENV, PATH: [first, second].join(path.delimiter) });
    expect(samePath(resolved?.path, binary)).toBe(true);
  });

  test("returns null when nothing is found", () => {
    expect(resolveGodotBinary(null, { ...EMPTY_ENV, PATH: tempDir() })).toBeNull();
  });

  test("ignores a directory named like the binary", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, process.platform === "win32" ? "godot.exe" : "godot"));
    expect(resolveGodotBinary(null, { ...EMPTY_ENV, PATH: dir })).toBeNull();
  });
});

describe("searchedLocations", () => {
  test("names PATH and the platform install roots for the not-found message", () => {
    const places = searchedLocations(EMPTY_ENV);
    expect(places[0]).toContain("PATH");
    expect(places.length).toBeGreaterThan(1);
  });
});

describe("GodotResolver", () => {
  test("caches the answer and reset re-resolves", () => {
    const resolver = new GodotResolver("/somewhere/godot");
    expect(resolver.resolve()).toBe(resolver.resolve());
    resolver.reset();
    expect(resolver.resolve()?.path).toBe("/somewhere/godot");
  });
});
