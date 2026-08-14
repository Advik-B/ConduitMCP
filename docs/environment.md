# Environment variables

Every environment variable Conduit reads, in three groups. The groups matter:
the first two configure a running system, the third exists only for building and
testing Conduit itself and has no effect on an installed broker.

Nothing here is required for ordinary use. Point the broker at a Godot project
and it derives everything else: the editor endpoint from the project path, the
engine binary from your PATH when a tool needs one, and the addon from the
release matching its own version.

## Boolean values

Every variable marked *flag* below is off when unset, empty, `0`, `false`, `no`,
or `off` (case-insensitive, surrounding whitespace ignored), and on for any
other value. `CONDUIT_DISABLE_EVAL=0` therefore means eval stays enabled, which
is what writing it into a config file looks like it should mean. The broker and
the bridge apply the same rule, which matters for `CONDUIT_TCP`: both ends
derive their endpoint from it, so a disagreement would leave them looking for
each other on different transports.

## Broker

Read by the MCP server, `conduit-mcp-server`. Where a command-line flag exists it
takes precedence over the environment variable.

| Variable | Flag | Effect |
| --- | --- | --- |
| `CONDUIT_PROJECT` | `--project <path>` | The Godot project directory to attach to. Required unless `CONDUIT_SOCK` is set. Resolved to an absolute path, so a relative value is interpreted against the broker's working directory, which an MCP client chooses; prefer an absolute path. |
| `CONDUIT_SOCK` | | An explicit editor endpoint, used verbatim: a socket path on Linux and macOS, a pipe name or full `\\.\pipe\` path on Windows. Bypasses the project-path hash entirely. Mostly for tests and unusual sandboxes. Game bridges deliberately ignore it, so an editor-launched game does not collide with the editor's endpoint. |
| `CONDUIT_RUNTIME_DIR` | | Directory holding the Unix socket endpoints, and where a broker-launched editor writes its log. Defaults to the system temp directory. Keep it short: a Unix socket path must fit `sun_path`, about 104 bytes on macOS. Unused on Windows, where the transport is a named pipe. |
| `CONDUIT_TCP` | | *Flag.* Use a loopback TCP endpoint instead of a Unix socket or named pipe. The port is derived from the same hash as the endpoint name, in the 49152-65535 range, bound to `127.0.0.1` only. For sandboxes where local sockets are unavailable; it also disables the endpoint scan the broker uses to explain a missing editor, because a TCP port has nothing to enumerate. |
| `CONDUIT_GODOT` | `--godot <path>` | Override the engine binary used by `gd_editor_launch`. Not needed normally: the broker looks on `PATH` (`godot4`, `godot`, `Godot`) and then in the usual per-platform install locations. Attaching to an editor you opened yourself never uses this. |
| `CONDUIT_AUTO_INSTALL` | `--auto-install` | *Flag.* On startup, if the configured directory is a Godot project with no addon installed, download the addon matching this broker's version and write it to `addons/conduit/`, then register the `ConduitRuntime` autoload in `project.godot` (backing the file up to `project.godot.conduit-backup` first). Off by default. See [Addon installation](#addon-installation). |
| `CONDUIT_ADDON_SOURCE` | `--addon-source <path\|url>` | Where the addon comes from instead of the GitHub release: a local `.zip`, an already-unpacked directory, or a URL. Use it for offline installs, air-gapped machines, or testing a build before it is released. |
| `CONDUIT_ENABLE_PIXEL_TOOLS` | `--enable-pixel-tools` | *Flag.* Register the tier-3 editor mouse tools, which drive the editor by screen coordinate. Off by default (whitepaper section 9). |
| `CONDUIT_ENABLE_EDITOR_EVAL` | `--enable-editor-eval` | *Flag.* Register `gd_editor_eval`, which runs arbitrary GDScript in the editor process with the editor's full authority over the project. Off by default. |
| `CONDUIT_DISABLE_EVAL` | `--disable-eval` | *Flag.* Drop the entire eval class: `gd_game_eval`, `gd_editor_eval`, the networking tools, and project-defined `gd_project_*` tools. Wins over the two opt-ins above. |

## Engine

Read by the bridge, the GDExtension loaded into the Godot editor and game
processes. Set these on the Godot process, not on the broker.

| Variable | Effect |
| --- | --- |
| `CONDUIT_ENABLE` | *Flag.* Lets the bridge activate in a **game** process. Equivalent to passing `--conduit` (or a bare `conduit`) as a user argument. The editor personality needs no opt-in. This never overrides the release guard: in an exported release build the listener does not bind regardless of this variable. |
| `CONDUIT_RUNTIME_DIR` | Directory for the socket endpoint, as above. Must match the broker's value. A broker-launched editor inherits it automatically. |
| `CONDUIT_TCP` | *Flag.* Loopback TCP transport, as above. Must match the broker's value. |
| `CONDUIT_SOCK` | Explicit endpoint override, honoured by the **editor** role only. The game role ignores it on purpose: a game launched from the editor inherits the editor's environment and must not bind the editor's endpoint. |

## Development and CI

Used only when building or testing Conduit from a clone. An installed broker
reads none of these; in particular the broker never reads `GODOT_BIN`.

| Variable | Read by | Effect |
| --- | --- | --- |
| `GODOT_BIN` | `tests/evals/harness.ts`, `scripts/setup.ts` | Path to a Godot 4.4+ editor binary for the acceptance runners. Falls back to the `tools/godot/GODOT_BIN` pointer file written by `bun scripts/setup.ts`. |
| `GODOT_VERSION` | `scripts/setup.ts`, CI workflows | Pin the Godot release tag `setup.ts` downloads, for example `4.7.1-stable`, instead of resolving the latest. |
| `TAG` | `scripts/check-version.ts` | The release tag to validate against the workspace `Cargo.toml` version. Set by the release workflow. |
| `GDRUST_SUPPRESSED_WARNINGS` | gdext, via `scripts/demo/record.ts` | Silences a named gdext warning during demo recording. Consumed by the dependency, not by Conduit. |

## Addon installation

Conduit is two halves: the broker on this side, and a GDExtension that has to
live in the Godot project. `CONDUIT_AUTO_INSTALL=1` makes the broker install
that second half itself.

It installs only when the addon is **missing**: the directory has a
`project.godot` and no `addons/conduit/`. Three other states report through
`gd_status` and `gd_addon_status` instead of installing:

- **current** - installed by Conduit, version matches this broker. Nothing to do.
- **stale** - installed by Conduit, version does not match. Fix it with
  `gd_addon_install` after closing the editor.
- **unmanaged** - `addons/conduit/` exists but Conduit did not put it there (no
  `.conduit-version` marker). Never replaced without `force`.

Installing is refused while an editor bridge is connected, and this is not a
convenience check: Godot loads a GDExtension only at startup, so installing into
a running editor could not take effect, and `project.godot` belongs to that
editor for the rest of its session. Close Godot, install, then reopen.

Without the environment variable the broker still detects and reports the state,
and `gd_addon_install` performs the same install on request. The variable only
controls whether it happens unattended at startup.

Downloads come from the GitHub release matching the broker's version and are
verified against the `SHA256SUMS.txt` published beside them; a mismatch fails the
install rather than unpacking the archive. `CONDUIT_ADDON_SOURCE` skips both the
download and, for a local path, the checksum.

## Example

A typical MCP client entry needs none of these:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "conduit-mcp-server", "--project", "/absolute/path/to/your-godot-project"]
    }
  }
}
```

A first-run entry that installs the addon and enables game-side tools:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "conduit-mcp-server", "--project", "/absolute/path/to/your-godot-project"],
      "env": {
        "CONDUIT_AUTO_INSTALL": "1",
        "CONDUIT_ENABLE": "1"
      }
    }
  }
}
```

`CONDUIT_ENABLE` appears in the broker's environment here so that a game the
broker launches through the editor inherits it; the broker itself does not read
it. If you start the editor yourself and want game-side tools, set it on that
process instead:

```
CONDUIT_ENABLE=1 godot --editor --path .          # Linux, macOS
$env:CONDUIT_ENABLE=1; godot --editor --path .    # PowerShell
```
