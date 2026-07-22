import { afterEach, describe, expect, test } from "bun:test";

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { BridgeError } from "../src/ipc-client.ts";
import { scaffoldProject } from "../src/tools/session.ts";

const cleanups: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop()!, { recursive: true, force: true });
  }
});

function fakeLibrary(): string {
  const dir = tempDir("conduit-lib-");
  const name = process.platform === "win32" ? "conduit.dll" : process.platform === "darwin" ? "libconduit.dylib" : "libconduit.so";
  const path = join(dir, name);
  writeFileSync(path, "not a real library");
  return path;
}

describe("scaffoldProject", () => {
  test("writes the project files and copies the bridge library", () => {
    const target = tempDir("conduit-scaffold-");
    const library = fakeLibrary();
    const written = scaffoldProject(target, "Test Project", library, false);

    expect(existsSync(join(target, "project.godot"))).toBe(true);
    expect(existsSync(join(target, "addons", "conduit", "conduit_runtime.tscn"))).toBe(true);
    expect(existsSync(join(target, "addons", "conduit", "conduit.gdextension"))).toBe(true);
    expect(written.length).toBe(4);

    const project = readFileSync(join(target, "project.godot"), "utf8");
    expect(project).toContain('config/name="Test Project"');
    expect(project).toContain('ConduitRuntime="*res://addons/conduit/conduit_runtime.tscn"');
    expect(project).toContain("config_version=5");

    const scene = readFileSync(join(target, "addons", "conduit", "conduit_runtime.tscn"), "utf8");
    expect(scene).toContain('[node name="ConduitRuntime" type="ConduitRuntime"]');

    // The manifest must point every host key at the copied library inside the
    // addon; a wrong key silently fails to load.
    const manifest = readFileSync(join(target, "addons", "conduit", "conduit.gdextension"), "utf8");
    expect(manifest).toContain('entry_symbol = "gdext_rust_init"');
    const libName = library.split(/[\\/]/).pop()!;
    expect(existsSync(join(target, "addons", "conduit", libName))).toBe(true);
    const hostKey =
      process.platform === "win32" ? "windows.debug.x86_64" : process.platform === "darwin" ? "macos.debug" : "linux.debug.x86_64";
    const releaseKey = hostKey.replace("debug", "release");
    expect(manifest).toContain(`${hostKey} = "res://addons/conduit/${libName}"`);
    expect(manifest).toContain(`${releaseKey} = "res://addons/conduit/${libName}"`);
  });

  test("refuses to overwrite an existing project without force", () => {
    const target = tempDir("conduit-scaffold-");
    const library = fakeLibrary();
    scaffoldProject(target, "First", library, false);
    let captured: BridgeError | null = null;
    try {
      scaffoldProject(target, "Second", library, false);
    } catch (error) {
      captured = error as BridgeError;
    }
    expect(captured?.code).toBe("already_exists");

    // force overwrites.
    scaffoldProject(target, "Second", library, true);
    expect(readFileSync(join(target, "project.godot"), "utf8")).toContain('config/name="Second"');
  });

  test("reports a missing bridge library", () => {
    const target = tempDir("conduit-scaffold-");
    let captured: BridgeError | null = null;
    try {
      scaffoldProject(target, "X", join(target, "nope.dll"), false);
    } catch (error) {
      captured = error as BridgeError;
    }
    expect(captured?.code).toBe("bridge_library_not_found");
  });
});
