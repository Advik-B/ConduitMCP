// Per-platform transport endpoint resolution, mirroring bridge/src/transport/ipc.rs.
// Unix uses a filesystem Unix-domain socket, Windows a named pipe, and an opt-in
// loopback TCP fallback (CONDUIT_TCP) covers the editor connection. Both ends
// derive the same endpoint from the shared FNV hash of the canonical project key
// (whitepaper section 7.2), so no coordination beyond the project path is needed.

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { canonicalProjectKey, shortHash } from "./framing.ts";

// A connectable endpoint: a Unix socket path or Windows pipe path (string), or a
// loopback TCP address (object). Passed straight to net.createConnection.
export type Endpoint = string | { host: string; port: number };

// The Windows named-pipe namespace. Enumerable via readdirSync with the trailing
// backslash (a Node/Bun quirk), which is how game bridges are discovered there.
const PIPE_DIR = "\\\\.\\pipe\\";

const isWindows = process.platform === "win32";

export function tcpEnabled(): boolean {
  return !!process.env.CONDUIT_TCP;
}

/** A stable string key for an endpoint, for dedup/tracking. */
export function endpointKey(endpoint: Endpoint): string {
  return typeof endpoint === "string" ? endpoint : `${endpoint.host}:${endpoint.port}`;
}

// FNV-1a over the token, into the IANA dynamic/private port range. Must match
// the Rust `tcp_port_for`.
function tcpPortFor(token: string): number {
  let hash = 2166136261;
  for (const byte of Buffer.from(token, "utf8")) {
    hash = (hash ^ byte) >>> 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return 49152 + (hash % 16384);
}

function localEndpointForToken(runtimeDir: string, token: string): Endpoint {
  if (tcpEnabled()) {
    return { host: "127.0.0.1", port: tcpPortFor(token) };
  }
  return isWindows ? `${PIPE_DIR}${token}` : join(runtimeDir, `${token}.sock`);
}

export function projectHash(projectPath: string): string {
  return shortHash(canonicalProjectKey(projectPath));
}

/** The editor endpoint derived from the project path (whitepaper section 7.2). */
export function editorEndpoint(runtimeDir: string, projectPath: string): Endpoint {
  return localEndpointForToken(runtimeDir, `conduit-editor-${projectHash(projectPath)}`);
}

/** Interpret an explicit CONDUIT_SOCK override verbatim (a path on Unix, a pipe
 * name or path on Windows). */
export function editorEndpointFromOverride(override: string): Endpoint {
  if (isWindows) {
    const name = override.startsWith(PIPE_DIR) ? override.slice(PIPE_DIR.length) : override;
    return `${PIPE_DIR}${name}`;
  }
  return override;
}

/** Rebuild a connectable endpoint from a bare game token (conduit-game-<hash>-<pid>). */
export function gameEndpointFromToken(runtimeDir: string, token: string): Endpoint {
  return isWindows ? `${PIPE_DIR}${token}` : join(runtimeDir, `${token}.sock`);
}

/**
 * Discover the bare game tokens currently advertised, scoped to a project hash
 * when known. On Unix the tokens are `.sock` files in the runtime directory; on
 * Windows they are pipe names enumerated from the pipe namespace. The pid-bearing
 * suffix means one project can have several tokens (several game instances).
 */
export function listGameTokens(runtimeDir: string, hash?: string): string[] {
  const prefix = hash ? `conduit-game-${hash}-` : "conduit-game-";
  if (isWindows) {
    let names: string[];
    try {
      names = readdirSync(PIPE_DIR);
    } catch {
      return [];
    }
    return names.filter((name) => name.startsWith(prefix));
  }
  let entries: string[];
  try {
    entries = readdirSync(runtimeDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith(prefix) && name.endsWith(".sock"))
    .map((name) => name.slice(0, -".sock".length));
}
