import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectAddon, hasAutoload, installAddon, withAutoload } from "../src/addon.ts";

const temporaries: string[] = [];

function tempProject(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conduit-addon-test-"));
  temporaries.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

/** An unpacked addon source, the shape CONDUIT_ADDON_SOURCE accepts as a directory. */
function sourceDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conduit-addon-src-"));
  temporaries.push(dir);
  const addon = path.join(dir, "addons", "conduit");
  fs.mkdirSync(path.join(addon, "bin"), { recursive: true });
  fs.writeFileSync(path.join(addon, "conduit.gdextension"), "[configuration]\n");
  fs.writeFileSync(path.join(addon, "conduit_runtime.tscn"), "[gd_scene format=3]\n");
  fs.writeFileSync(path.join(addon, "bin", "libconduit.so"), "binary");
  return dir;
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const MINIMAL_PROJECT = 'config_version=5\n\n[application]\n\nconfig/name="Test"\n';

describe("detectAddon", () => {
  test("reports a directory with no project.godot as invalid", () => {
    const detection = detectAddon(tempProject(), "0.3.1");
    expect(detection.projectValid).toBe(false);
    expect(detection.state).toBe("missing");
  });

  test("reports a valid project with no addon as missing", () => {
    const detection = detectAddon(tempProject({ "project.godot": MINIMAL_PROJECT }), "0.3.1");
    expect(detection).toEqual({ projectValid: true, state: "missing", installedVersion: null, autoloadPresent: false });
  });

  test("matches the marker version as current", () => {
    const dir = tempProject({
      "project.godot": MINIMAL_PROJECT,
      "addons/conduit/conduit.gdextension": "[configuration]\n",
      "addons/conduit/.conduit-version": "0.3.1\n",
    });
    expect(detectAddon(dir, "0.3.1").state).toBe("current");
  });

  test("treats a different marker version as stale, not missing", () => {
    const dir = tempProject({
      "project.godot": MINIMAL_PROJECT,
      "addons/conduit/conduit.gdextension": "[configuration]\n",
      "addons/conduit/.conduit-version": "0.2.0\n",
    });
    const detection = detectAddon(dir, "0.3.1");
    expect(detection.state).toBe("stale");
    expect(detection.installedVersion).toBe("0.2.0");
  });

  test("treats a hand-extracted addon as unmanaged", () => {
    const dir = tempProject({
      "project.godot": MINIMAL_PROJECT,
      "addons/conduit/conduit.gdextension": "[configuration]\n",
    });
    expect(detectAddon(dir, "0.3.1").state).toBe("unmanaged");
  });

  test("sees an existing autoload registration", () => {
    const dir = tempProject({
      "project.godot": `${MINIMAL_PROJECT}\n[autoload]\n\nConduitRuntime="*res://addons/conduit/conduit_runtime.tscn"\n`,
    });
    expect(detectAddon(dir, "0.3.1").autoloadPresent).toBe(true);
  });
});

describe("withAutoload", () => {
  test("appends a new section when the file has none", () => {
    const updated = withAutoload(MINIMAL_PROJECT);
    expect(updated).not.toBeNull();
    expect(hasAutoload(updated as string)).toBe(true);
    expect(updated).toContain('config/name="Test"');
  });

  test("inserts into an existing section without disturbing later ones", () => {
    const original = [
      "config_version=5",
      "",
      "[autoload]",
      "",
      'Existing="*res://existing.tscn"',
      "",
      "[rendering]",
      "",
      'renderer/rendering_method="gl_compatibility"',
      "",
    ].join("\n");
    const updated = withAutoload(original) as string;
    const lines = updated.split("\n");
    expect(lines.indexOf('ConduitRuntime="*res://addons/conduit/conduit_runtime.tscn"')).toBeGreaterThan(
      lines.indexOf('Existing="*res://existing.tscn"'),
    );
    expect(lines.indexOf('ConduitRuntime="*res://addons/conduit/conduit_runtime.tscn"')).toBeLessThan(
      lines.indexOf("[rendering]"),
    );
    expect(updated).toContain('renderer/rendering_method="gl_compatibility"');
  });

  test("preserves CRLF line endings", () => {
    const updated = withAutoload(MINIMAL_PROJECT.replace(/\n/g, "\r\n")) as string;
    expect(updated).toContain("\r\n");
    expect(updated.split("\r\n\r\n").length).toBeGreaterThan(1);
    expect(updated.replace(/\r\n/g, "")).not.toContain("\n");
  });

  test("preserves comments", () => {
    const updated = withAutoload(`; Engine configuration file.\n${MINIMAL_PROJECT}`) as string;
    expect(updated).toContain("; Engine configuration file.");
  });

  test("is a no-op when already registered", () => {
    expect(withAutoload(`${MINIMAL_PROJECT}\n[autoload]\n\nConduitRuntime="*res://x.tscn"\n`)).toBeNull();
  });
});

describe("installAddon", () => {
  test("installs from a directory source and registers the autoload", async () => {
    const project = tempProject({ "project.godot": MINIMAL_PROJECT });
    const result = await installAddon({ projectPath: project, version: "0.3.1", source: sourceDir() });

    expect(result.installed).toBe(true);
    expect(result.autoloadAdded).toBe(true);
    expect(fs.existsSync(path.join(project, "addons", "conduit", "bin", "libconduit.so"))).toBe(true);
    expect(fs.readFileSync(path.join(project, "addons", "conduit", ".conduit-version"), "utf8").trim()).toBe("0.3.1");
    expect(hasAutoload(fs.readFileSync(path.join(project, "project.godot"), "utf8"))).toBe(true);
    expect(fs.existsSync(path.join(project, "project.godot.conduit-backup"))).toBe(true);
    expect(detectAddon(project, "0.3.1").state).toBe("current");
    // The staging directory must not survive a successful install.
    expect(fs.existsSync(path.join(project, "addons", ".conduit-install-tmp"))).toBe(false);
  });

  test("skips the autoload edit when asked", async () => {
    const project = tempProject({ "project.godot": MINIMAL_PROJECT });
    const result = await installAddon({ projectPath: project, version: "0.3.1", source: sourceDir(), autoload: false });
    expect(result.autoloadAdded).toBe(false);
    expect(hasAutoload(fs.readFileSync(path.join(project, "project.godot"), "utf8"))).toBe(false);
  });

  test("refuses a directory that is not a Godot project", async () => {
    await expect(installAddon({ projectPath: tempProject(), version: "0.3.1", source: sourceDir() })).rejects.toThrow(
      /no project.godot/,
    );
  });

  test("refuses to replace an unmanaged install without force", async () => {
    const project = tempProject({
      "project.godot": MINIMAL_PROJECT,
      "addons/conduit/conduit.gdextension": "hand written\n",
    });
    await expect(installAddon({ projectPath: project, version: "0.3.1", source: sourceDir() })).rejects.toThrow(
      /not installed by Conduit/,
    );
    expect(fs.readFileSync(path.join(project, "addons", "conduit", "conduit.gdextension"), "utf8")).toBe("hand written\n");
  });

  test("replaces a stale install and leaves no files from the old one", async () => {
    const project = tempProject({
      "project.godot": MINIMAL_PROJECT,
      "addons/conduit/conduit.gdextension": "old\n",
      "addons/conduit/.conduit-version": "0.2.0\n",
      "addons/conduit/stale-leftover.txt": "gone",
    });
    expect(detectAddon(project, "0.3.1").state).toBe("stale");
    await installAddon({ projectPath: project, version: "0.3.1", source: sourceDir() });
    expect(detectAddon(project, "0.3.1").state).toBe("current");
    expect(fs.existsSync(path.join(project, "addons", "conduit", "stale-leftover.txt"))).toBe(false);
  });

  test("refuses to reinstall a current addon without force", async () => {
    const project = tempProject({ "project.godot": MINIMAL_PROJECT });
    const source = sourceDir();
    await installAddon({ projectPath: project, version: "0.3.1", source });
    await expect(installAddon({ projectPath: project, version: "0.3.1", source })).rejects.toThrow(/already installed/);
    await expect(installAddon({ projectPath: project, version: "0.3.1", source, force: true })).resolves.toBeDefined();
  });

  // A failed source leaves the previous install untouched: staging happens
  // before anything in addons/conduit is removed.
  test("a failed install does not damage an existing addon", async () => {
    const project = tempProject({ "project.godot": MINIMAL_PROJECT });
    await installAddon({ projectPath: project, version: "0.3.1", source: sourceDir() });
    await expect(
      installAddon({ projectPath: project, version: "0.3.1", source: path.join(project, "nope.zip"), force: true }),
    ).rejects.toThrow(/does not exist/);
    expect(detectAddon(project, "0.3.1").state).toBe("current");
    expect(fs.existsSync(path.join(project, "addons", "conduit", "conduit.gdextension"))).toBe(true);
    expect(fs.existsSync(path.join(project, "addons", ".conduit-install-tmp"))).toBe(false);
  });

  test("rejects a source with no addon in it", async () => {
    const empty = tempProject({ "readme.txt": "nothing here" });
    await expect(
      installAddon({ projectPath: tempProject({ "project.godot": MINIMAL_PROJECT }), version: "0.3.1", source: empty }),
    ).rejects.toThrow(/no conduit.gdextension/);
  });
});
