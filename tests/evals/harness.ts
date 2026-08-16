// Shared cross-platform helpers for the phase acceptance runners. Centralises
// every host-specific assumption the runners used to hardcode: /tmp socket dirs,
// xvfb, pkill, and Linux-only Godot paths. The runners drive the same acceptance
// logic on Linux, macOS, and Windows through these helpers.
//
// Endpoint discovery goes through the broker's own endpoint module, so the
// runners exercise the real hash-based discovery path (bridge and broker
// deriving the same endpoint from the project path) rather than pinning
// CONDUIT_SOCK, which never exercised that path.

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import {
  editorEndpoint,
  type Endpoint,
  endpointKey,
  gameEndpointFromToken,
  listGameTokens,
  projectHash,
} from "../../broker/src/endpoint.ts";

export { endpointKey } from "../../broker/src/endpoint.ts";
export type { Endpoint } from "../../broker/src/endpoint.ts";

export const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
export const exampleProject = join(repoRoot, "example-project");

export const isWindows = process.platform === "win32";
export const isLinux = process.platform === "linux";

const PIPE_DIR = "\\\\.\\pipe\\";

/**
 * A short, private runtime directory. Kept short because a Unix-domain socket
 * path must fit `sun_path` (~104 bytes on macOS); `/tmp` is short on both Linux
 * and macOS. On Windows the transport is a named pipe and this is only a
 * placeholder for CONDUIT_RUNTIME_DIR.
 */
export function runtimeDir(tag: string): string {
  const base = isWindows ? os.tmpdir() : "/tmp";
  return join(base, `conduit-${tag}-${process.pid}`);
}

/** Environment that makes the bridge and broker derive the same endpoint from
 * the example project's path (hash-based discovery). */
export function conduitEnv(rtDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    CONDUIT_PROJECT: exampleProject,
    CONDUIT_RUNTIME_DIR: rtDir,
    CONDUIT_ENABLE: "1",
    ...extra,
  } as Record<string, string>;
}

/** The editor endpoint both ends derive; used for raw BridgeClient probes and
 * for readiness checks. Defaults to the example project, which is what every
 * phase runner drives; the demo recorder passes its own throwaway copy. */
export function editorEndpointFor(rtDir: string, project: string = exampleProject): Endpoint {
  // Resolved, not just absolute, matching what the broker hashes and what the
  // bridge gets from globalize_path("res://"). On macOS a project under
  // os.tmpdir() sits below /var, a symlink into /private, so an unresolved path
  // here would have a runner watching a socket name nothing ever binds
  // (docs/api-gaps.md).
  return editorEndpoint(rtDir, realProjectDir(project));
}

/** The project path as both the broker and the bridge see it. Mirrors
 * realProjectPath in broker/src/index.ts; a directory that does not exist yet is
 * left as-is, since only scaffolding runners hit that and they pass the path on
 * rather than hashing it here. */
export function realProjectDir(project: string): string {
  try {
    return realpathSync(project);
  } catch {
    return project;
  }
}

export function resolveGodot(): string {
  const env = process.env.GODOT_BIN;
  if (env && existsSync(env)) {
    return env;
  }
  const pointer = join(repoRoot, "tools", "godot", "GODOT_BIN");
  if (existsSync(pointer)) {
    const path = readFileSync(pointer, "utf8").trim();
    if (existsSync(path)) {
      return path;
    }
  }
  throw new Error("GODOT_BIN not set and tools/godot/GODOT_BIN missing; run `bun scripts/setup.ts`");
}

/**
 * Build the Godot launch argv. Rendering phases need a real display: on Linux
 * that is Xvfb (headless CI has no X server); on Windows and macOS Godot renders
 * to a native display, so it runs directly. Headless phases pass `render:false`.
 *
 * Pass `display` when the caller already owns a display (see
 * {@link startVirtualDisplay}) and sets `DISPLAY` in the child environment
 * itself; `xvfb-run` would otherwise start a second server on a number the
 * caller cannot predict, which is no good for anything that has to attach to
 * the display from outside, like a screen recorder.
 */
export function godotCommand(godot: string, args: string[], render: boolean, display?: string): string[] {
  if (render && isLinux && !display) {
    return ["xvfb-run", "-a", "-s", "-screen 0 1280x720x24", godot, ...args];
  }
  return [godot, ...args];
}

export interface VirtualDisplay {
  /** The X display name, for example ":99". */
  display: string;
  width: number;
  height: number;
  stop(): void;
}

/**
 * Start an Xvfb server on a display number we choose, so callers can attach to
 * it by name. Linux only, like the rest of the Xvfb path: Windows and macOS
 * render to a native display and have no equivalent (docs/api-gaps.md).
 */
export async function startVirtualDisplay(width: number, height: number): Promise<VirtualDisplay> {
  if (!isLinux) {
    throw new Error("startVirtualDisplay is Linux-only; Windows and macOS render to a native display");
  }
  if (Bun.spawnSync(["which", "Xvfb"]).exitCode !== 0) {
    throw new Error("Xvfb not found; run `bun scripts/setup.ts` to install it (needs apt)");
  }
  const number = firstFreeDisplayNumber();
  const display = `:${number}`;
  const proc = Bun.spawn(["Xvfb", display, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const socket = `/tmp/.X11-unix/X${number}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(socket)) {
      return { display, width, height, stop: () => proc.kill() };
    }
    if (proc.exitCode !== null) {
      throw new Error(`Xvfb exited with code ${proc.exitCode} before ${display} was ready`);
    }
    await sleep(100);
  }
  proc.kill();
  throw new Error(`Xvfb did not bring up ${display} within 15 s`);
}

/** Lowest display number in [99, 128) with no X socket, to avoid colliding with
 * a desktop session or a concurrent xvfb-run. */
function firstFreeDisplayNumber(): number {
  for (let n = 99; n < 128; n++) {
    if (!existsSync(`/tmp/.X11-unix/X${n}`)) {
      return n;
    }
  }
  throw new Error("no free X display number in the range 99-127");
}

/** Ensure a virtual display is available where one is needed (Linux only). */
export function requireDisplay(): void {
  if (!isLinux) {
    return; // Windows and macOS render to a native display.
  }
  if (Bun.spawnSync(["which", "xvfb-run"]).exitCode !== 0) {
    throw new Error("xvfb-run not found; run `bun scripts/setup.ts` to install it (needs apt)");
  }
}

/** Whether the editor's endpoint is bound, without consuming a connection: pipe
 * enumeration on Windows, file existence on Unix, a connect probe for TCP. */
async function endpointReady(endpoint: Endpoint): Promise<boolean> {
  if (typeof endpoint !== "string") {
    return canConnectTcp(endpoint);
  }
  if (isWindows) {
    const name = endpoint.startsWith(PIPE_DIR) ? endpoint.slice(PIPE_DIR.length) : endpoint;
    try {
      return readdirSync(PIPE_DIR).includes(name);
    } catch {
      return false;
    }
  }
  return existsSync(endpoint);
}

function canConnectTcp(endpoint: { host: string; port: number }): Promise<boolean> {
  return new Promise((resolve) => {
    import("node:net").then((net) => {
      const socket = net.default.createConnection(endpoint.port, endpoint.host);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
  });
}

/** Wait for the editor bridge endpoint to appear, returning it. */
export async function waitForEditor(rtDir: string, timeoutMs: number, project?: string): Promise<Endpoint> {
  const endpoint = editorEndpointFor(rtDir, project);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await endpointReady(endpoint)) {
      return endpoint;
    }
    await sleep(200);
  }
  throw new Error(`editor bridge endpoint ${endpointKey(endpoint)} did not appear within ${timeoutMs} ms`);
}

/** Wait for a bare game bridge (launched with CONDUIT_ENABLE, not via gd_play)
 * to advertise its endpoint, scoped to the example project's hash. Returns the
 * first game endpoint found, or null on timeout. */
export async function waitForGameEndpoint(rtDir: string, timeoutMs: number): Promise<Endpoint | null> {
  const hash = projectHash(exampleProject);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tokens = listGameTokens(rtDir, hash);
    if (tokens.length > 0) {
      return gameEndpointFromToken(rtDir, tokens[0]!);
    }
    await sleep(300);
  }
  return null;
}

/** Kill a spawned Godot process and any game it launched. Replaces the POSIX-only
 * `pkill -f example-project`: taskkill /T tears down the process tree on Windows;
 * on POSIX we kill the handle plus any lingering game by name. */
export function killTree(proc: { pid?: number | null; kill: () => void }): void {
  if (isWindows) {
    if (proc.pid != null) {
      Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(proc.pid)]);
    }
    return;
  }
  proc.kill();
  Bun.spawnSync(["pkill", "-f", "example-project"]);
}

/** The export preset name for the host platform (whitepaper section 15 presets). */
export function hostExportPreset(kind: "debug" | "release"): string {
  const platform = isWindows ? "Windows Desktop" : process.platform === "darwin" ? "macOS" : "Linux";
  return `${platform} (${kind})`;
}
