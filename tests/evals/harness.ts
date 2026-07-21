// Shared cross-platform helpers for the phase acceptance runners. Centralises
// every host-specific assumption the runners used to hardcode: /tmp socket dirs,
// xvfb, pkill, and Linux-only Godot paths. The runners drive the same acceptance
// logic on Linux, macOS, and Windows through these helpers.
//
// Endpoint discovery goes through the broker's own endpoint module, so the
// runners exercise the real hash-based discovery path (bridge and broker
// deriving the same endpoint from the project path) rather than pinning
// CONDUIT_SOCK, which never exercised that path.

import { existsSync, readFileSync, readdirSync } from "node:fs";
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
 * for readiness checks. */
export function editorEndpointFor(rtDir: string): Endpoint {
  return editorEndpoint(rtDir, exampleProject);
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
 */
export function godotCommand(godot: string, args: string[], render: boolean): string[] {
  if (render && isLinux) {
    return ["xvfb-run", "-a", "-s", "-screen 0 1280x720x24", godot, ...args];
  }
  return [godot, ...args];
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
export async function waitForEditor(rtDir: string, timeoutMs: number): Promise<Endpoint> {
  const endpoint = editorEndpointFor(rtDir);
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
