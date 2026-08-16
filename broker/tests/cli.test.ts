import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyTransportEnv, parseCli, runCli } from "../src/cli.ts";
import { envInt } from "../src/env.ts";
import { realProjectPath, resolveConfig } from "../src/index.ts";

const VERSION = "9.9.9";

/** A bare environment, so a developer's real CONDUIT_ variables cannot leak in. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { CONDUIT_PROJECT: "/tmp/project", ...overrides };
}

describe("parseCli", () => {
  test("absent options stay undefined, so the environment can still be consulted", () => {
    expect(parseCli([], VERSION)).toEqual({});
  });

  test("accepts both --name value and --name=value", () => {
    expect(parseCli(["--project", "/a"], VERSION).project).toBe("/a");
    expect(parseCli(["--project=/a"], VERSION).project).toBe("/a");
  });

  test("booleans are three-state", () => {
    expect(parseCli([], VERSION).autoInstall).toBeUndefined();
    expect(parseCli(["--auto-install"], VERSION).autoInstall).toBe(true);
    expect(parseCli(["--no-auto-install"], VERSION).autoInstall).toBe(false);
    expect(parseCli([], VERSION).tcp).toBeUndefined();
    expect(parseCli(["--tcp"], VERSION).tcp).toBe(true);
    expect(parseCli(["--no-tcp"], VERSION).tcp).toBe(false);
  });

  test("parses every argv form the eval runners use", () => {
    const options = parseCli(
      ["--project", "/p", "--enable-pixel-tools", "--enable-editor-eval", "--auto-install", "--addon-source", "/a.zip"],
      VERSION,
    );
    expect(options).toEqual({
      project: "/p",
      enablePixelTools: true,
      enableEditorEval: true,
      autoInstall: true,
      addonSource: "/a.zip",
    });
  });

  test("rejects a non-positive or non-integer numeric option", () => {
    for (const bad of ["abc", "0", "-1", "1.5"]) {
      expect(() => parseCli(["--timeout-ms", bad], VERSION)).toThrow();
    }
    expect(parseCli(["--timeout-ms", "250"], VERSION).timeoutMs).toBe(250);
  });

  test("rejects an unknown option instead of ignoring it", () => {
    expect(() => parseCli(["--tool-group", "scene"], VERSION)).toThrow(/unknown option/);
  });

  // The old hand-rolled parser took argv[i + 1] unchecked, so this silently set
  // the project path to "--tcp" and failed much later as an endpoint mismatch.
  test("rejects a flag swallowed as the previous option's value", () => {
    expect(() => parseCli(["--project", "--tcp"], VERSION)).toThrow(/--project expects a value/);
  });

  // The old parser matched boolean flags with an exact string compare, so this
  // form was a silent no-op even though --project=/x worked.
  test("--disable-eval=1 is not silently ignored", () => {
    expect(() => parseCli(["--disable-eval=1"], VERSION)).toThrow();
    expect(parseCli(["--disable-eval"], VERSION).disableEval).toBe(true);
  });
});

describe("runCli", () => {
  test("--help and --version stop with exit code 0", () => {
    expect(runCli(["bun", "index.ts", "--help"], VERSION)).toEqual({ kind: "exit", code: 0 });
    expect(runCli(["bun", "index.ts", "--version"], VERSION)).toEqual({ kind: "exit", code: 0 });
  });

  test("a bad option stops with a non-zero code rather than throwing", () => {
    expect(runCli(["bun", "index.ts", "--nope"], VERSION)).toEqual({ kind: "exit", code: 1 });
  });

  test("consumes the runtime and script argv entries", () => {
    const result = runCli(["bun", "index.ts", "--project", "/p"], VERSION);
    expect(result).toEqual({ kind: "run", options: { project: "/p" } });
  });
});

describe("applyTransportEnv", () => {
  test("writes the transport flags into the environment the bridge inherits", () => {
    const target: NodeJS.ProcessEnv = {};
    applyTransportEnv({ runtimeDir: "/rt", sock: "/s.sock", tcp: true }, target);
    expect(target).toEqual({ CONDUIT_RUNTIME_DIR: "/rt", CONDUIT_SOCK: "/s.sock", CONDUIT_TCP: "1" });
  });

  test("--no-tcp writes an explicit off rather than leaving a stale value", () => {
    const target: NodeJS.ProcessEnv = { CONDUIT_TCP: "1" };
    applyTransportEnv({ tcp: false }, target);
    expect(target.CONDUIT_TCP).toBe("0");
  });

  test("absent flags leave the environment untouched", () => {
    const target: NodeJS.ProcessEnv = { CONDUIT_RUNTIME_DIR: "/existing" };
    applyTransportEnv({}, target);
    expect(target).toEqual({ CONDUIT_RUNTIME_DIR: "/existing" });
  });
});

describe("resolveConfig precedence", () => {
  test("a string option beats its environment variable", () => {
    expect(resolveConfig({ project: "/from-cli" }, env()).projectPath).toContain("from-cli");
    expect(resolveConfig({}, env()).projectPath).toContain("project");
  });

  test("a boolean flag beats an unset variable, and a negation beats a set one", () => {
    expect(resolveConfig({}, env()).autoInstall).toBe(false);
    expect(resolveConfig({ autoInstall: true }, env()).autoInstall).toBe(true);
    expect(resolveConfig({}, env({ CONDUIT_AUTO_INSTALL: "1" })).autoInstall).toBe(true);
    expect(resolveConfig({ autoInstall: false }, env({ CONDUIT_AUTO_INSTALL: "1" })).autoInstall).toBe(false);
  });

  test("CONDUIT_DISABLE_EVAL=0 means off", () => {
    expect(resolveConfig({}, env({ CONDUIT_DISABLE_EVAL: "0" })).disableEval).toBe(false);
    expect(resolveConfig({}, env({ CONDUIT_DISABLE_EVAL: "1" })).disableEval).toBe(true);
  });

  test("timeouts fall back to the defaults and are overridden in order", () => {
    expect(resolveConfig({}, env()).timeouts).toEqual({ default: 10_000, await: 120_000, export: 600_000 });
    expect(resolveConfig({}, env({ CONDUIT_TIMEOUT_MS: "500" })).timeouts.default).toBe(500);
    expect(resolveConfig({ timeoutMs: 700 }, env({ CONDUIT_TIMEOUT_MS: "500" })).timeouts.default).toBe(700);
    expect(resolveConfig({ evalTimeoutMs: 1 }, env()).timeouts.await).toBe(1);
    expect(resolveConfig({ exportTimeoutMs: 2 }, env()).timeouts.export).toBe(2);
  });

  test("a malformed numeric variable is a startup error, not a silent default", () => {
    expect(() => resolveConfig({}, env({ CONDUIT_TIMEOUT_MS: "10s" }))).toThrow(/CONDUIT_TIMEOUT_MS/);
    expect(envInt("X", undefined)).toBeUndefined();
    expect(envInt("X", "")).toBeUndefined();
    expect(envInt("X", "42")).toBe(42);
  });

  test("the audit log is off unless a path is given, and 'off' disables it explicitly", () => {
    expect(resolveConfig({}, env()).auditLog).toBeNull();
    expect(resolveConfig({ auditLog: "off" }, env()).auditLog).toBeNull();
    expect(resolveConfig({}, env({ CONDUIT_AUDIT_LOG: "OFF" })).auditLog).toBeNull();
    expect(resolveConfig({ auditLog: "audit.jsonl" }, env()).auditLog).toContain("audit.jsonl");
  });

  test("no project and no socket override is a clear error", () => {
    expect(() => resolveConfig({}, {})).toThrow(/--project, CONDUIT_PROJECT, or CONDUIT_SOCK/);
  });

  test("unattended engine install is off unless asked for", () => {
    expect(resolveConfig({}, env()).autoInstallGodot).toBe(false);
    expect(resolveConfig({}, env({ CONDUIT_AUTO_INSTALL_GODOT: "1" })).autoInstallGodot).toBe(true);
    // The negation has to beat a set variable, or a config file that can set a
    // variable but not unset one could never turn the download off.
    expect(resolveConfig({ autoInstallGodot: false }, env({ CONDUIT_AUTO_INSTALL_GODOT: "1" })).autoInstallGodot).toBe(
      false,
    );
    expect(resolveConfig({}, env({ CONDUIT_AUTO_INSTALL_GODOT: "0" })).autoInstallGodot).toBe(false);
  });

  test("engine settings follow the same option-then-variable order", () => {
    expect(resolveConfig({}, env()).engineDir).toContain("engines");
    expect(resolveConfig({}, env({ CONDUIT_ENGINE_DIR: "/eng" })).engineDir).toBe("/eng");
    expect(resolveConfig({ engineDir: "/cli" }, env({ CONDUIT_ENGINE_DIR: "/eng" })).engineDir).toBe("/cli");

    expect(resolveConfig({}, env()).godotVersion).toBeNull();
    expect(resolveConfig({ godotVersion: "4.7.1-stable" }, env()).godotVersion).toBe("4.7.1-stable");
    expect(resolveConfig({}, env({ CONDUIT_GODOT_VERSION: "4.6-stable" })).godotVersion).toBe("4.6-stable");

    expect(resolveConfig({}, env()).godotMono).toBe(false);
    expect(resolveConfig({}, env({ CONDUIT_GODOT_MONO: "1" })).godotMono).toBe(true);
    expect(resolveConfig({}, env()).engineSource).toBeNull();
    expect(resolveConfig({}, env({ CONDUIT_ENGINE_SOURCE: "/local.zip" })).engineSource).toBe("/local.zip");
  });

  // --install-godot is a plain boolean rather than "--install-godot [version]".
  // An optional-argument option lands in checkMissingValues' takesValue set,
  // which would reject this correct command line as a missing value.
  test("--install-godot may be followed by another option", () => {
    expect(parseCli(["--install-godot", "--engine-dir", "/tmp/e"], VERSION)).toEqual({
      installGodot: true,
      engineDir: "/tmp/e",
    });
    expect(parseCli(["--install-godot", "--godot-mono"], VERSION)).toEqual({ installGodot: true, godotMono: true });
  });
});

// Both ends derive the endpoint from a hash of the project path, and the bridge
// gets its side from globalize_path("res://"), which Godot returns with every
// symlink resolved. If the broker does not match that, the two bind and wait on
// different socket names and never meet. macOS is where this bites, since /var
// and /tmp are symlinks into /private and a scaffolded project lands under one.
describe("project path normalisation", () => {
  const isWindows = process.platform === "win32";

  test("a symlinked project path resolves to the same path the bridge reports", () => {
    if (isWindows) {
      return; // creating a symlink needs elevation on Windows.
    }
    const base = mkdtempSync(join(tmpdir(), "conduit-realpath-"));
    const real = join(base, "real-project");
    const link = join(base, "linked-project");
    mkdirSync(real);
    symlinkSync(real, link);
    try {
      expect(realProjectPath(link)).toBe(realpathSync(real));
      // And the endpoint that follows from it, which is the thing that actually
      // has to agree.
      const viaLink = resolveConfig({ project: link }, { CONDUIT_RUNTIME_DIR: "/tmp" } as NodeJS.ProcessEnv);
      const viaReal = resolveConfig({ project: real }, { CONDUIT_RUNTIME_DIR: "/tmp" } as NodeJS.ProcessEnv);
      expect(viaLink.editorEndpoint).toEqual(viaReal.editorEndpoint);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a project directory that does not exist yet still resolves its symlinked prefix", () => {
    // gd_project_scaffold creates the project it is pointed at, so the path is
    // allowed not to exist when the broker starts.
    if (isWindows) {
      return;
    }
    const base = mkdtempSync(join(tmpdir(), "conduit-realpath-"));
    const link = join(base, "linked-parent");
    const real = join(base, "real-parent");
    mkdirSync(real);
    symlinkSync(real, link);
    try {
      expect(realProjectPath(join(link, "not-created-yet"))).toBe(join(realpathSync(real), "not-created-yet"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("an ordinary absolute path is returned unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "conduit-realpath-"));
    try {
      expect(realProjectPath(dir)).toBe(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
