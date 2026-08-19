# Configuration

Every command-line option and environment variable Conduit reads, in three
groups. The groups matter: the first two configure a running system, the third
exists only for building and testing Conduit itself and has no effect on an
installed broker.

Nothing here is required for ordinary use. Point the broker at a Godot project
and it derives everything else: the editor endpoint from the project path, the
engine binary from your PATH when a tool needs one, and the addon from the
release matching its own version.

Every broker variable has a command-line option, and the option wins. Run
`conduit-mcp-server --help` for the same list from the broker itself; it prints
to stderr, because stdout carries the MCP protocol.

## Boolean values

Every variable marked *flag* below is off when unset, empty, `0`, `false`, `no`,
or `off` (case-insensitive, surrounding whitespace ignored), and on for any
other value. `CONDUIT_DISABLE_EVAL=0` therefore means eval stays enabled, which
is what writing it into a config file looks like it should mean. The broker and
the bridge apply the same rule, which matters for `CONDUIT_TCP`: both ends
derive their endpoint from it, so a disagreement would leave them looking for
each other on different transports.

## Broker

Read by the MCP server, `conduit-mcp-server`. The command-line option always
takes precedence over the environment variable, and an unknown option is a
startup error rather than a silent no-op.

| Variable | Flag | Effect |
| --- | --- | --- |
| `CONDUIT_PROJECT` | `--project <path>` | The Godot project directory to attach to. Required unless `--sock` is given. Resolved to an absolute path, so a relative value is interpreted against the broker's working directory, which an MCP client chooses; prefer an absolute path. |
| `CONDUIT_SOCK` | `--sock <path>` | An explicit editor endpoint, used verbatim: a socket path on Linux and macOS, a pipe name or full `\\.\pipe\` path on Windows. Bypasses the project-path hash entirely. Mostly for tests and unusual sandboxes. Game bridges deliberately ignore it, so an editor-launched game does not collide with the editor's endpoint. |
| `CONDUIT_RUNTIME_DIR` | `--runtime-dir <path>` | Directory holding the Unix socket endpoints, and where a broker-launched editor writes its log. Defaults to the system temp directory. Keep it short: a Unix socket path must fit `sun_path`, about 104 bytes on macOS. Unused on Windows, where the transport is a named pipe. |
| `CONDUIT_TCP` | `--tcp` / `--no-tcp` | *Flag.* Use a loopback TCP endpoint instead of a Unix socket or named pipe. The port is derived from the same hash as the endpoint name, in the 49152-65535 range, bound to `127.0.0.1` only. For sandboxes where local sockets are unavailable; it also disables the endpoint scan the broker uses to explain a missing editor, because a TCP port has nothing to enumerate. |
| `CONDUIT_GODOT` | `--godot <path>` | Override the engine binary used by `gd_editor_launch`. Not needed normally: the broker looks on `PATH` (`godot4`, `godot`, `Godot`) and then in the usual per-platform install locations. Attaching to an editor you opened yourself never uses this. |
| `CONDUIT_AUTO_INSTALL` | `--auto-install` / `--no-auto-install` | *Flag.* On startup, if the configured directory is a Godot project with no addon installed, download the addon matching this broker's version and write it to `addons/conduit/`, then register the `ConduitRuntime` autoload in `project.godot` (backing the file up to `project.godot.conduit-backup` first). Off by default. See [Addon installation](#addon-installation). |
| `CONDUIT_ADDON_SOURCE` | `--addon-source <path\|url>` | Where the addon comes from instead of the GitHub release: a local `.zip`, an already-unpacked directory, or a URL. Use it for offline installs, air-gapped machines, or testing a build before it is released. |
| `CONDUIT_AUTO_INSTALL_GODOT` | `--auto-install-godot` / `--no-auto-install-godot` | *Flag.* Allow an engine to be installed without being asked, when none is found. Off by default, and separate from `CONDUIT_AUTO_INSTALL` because an engine is a 60-200 MB machine-wide download rather than a few files in one project. Calling `gd_engine_install` yourself never needs this. See [Engine installation](#engine-installation). |
| `CONDUIT_ENGINE_DIR` | `--engine-dir <path>` | Root holding one directory per installed engine build. Defaults to `~/.conduit/engines`. Never a system location: Conduit installs engines for the user running it, and never touches an engine it did not install. |
| `CONDUIT_ENGINE_SOURCE` | `--engine-source <path\|url>` | Where the engine comes from instead of the Godot release: a local `.zip`, an already-unpacked directory, or a URL. For offline and air-gapped installs. As with `CONDUIT_ADDON_SOURCE`, an explicit source is not checksum-verified: you are vouching for it. |
| `CONDUIT_GODOT_VERSION` | `--godot-version <tag>` | Engine release to install, for example `4.7.1-stable`. Omitted installs the latest stable release. Applies to `--install-godot` and the unattended path; unrelated to `CONDUIT_GODOT`, which points at a binary you already have. |
| `CONDUIT_GODOT_MONO` | `--godot-mono` | *Flag.* Install the .NET/C# engine build (Godot Mono) instead of the standard one. Needed for projects with C# scripts; the standard build cannot open them. Both builds of a version can be installed side by side. |
| | `--install-godot` | Install an engine and exit, without starting a server. Needs no `--project`, since installing an engine has nothing to do with a project. |
| `CONDUIT_ENABLE_PIXEL_TOOLS` | `--enable-pixel-tools` | *Flag.* Register the tier-3 editor mouse tools, which drive the editor by screen coordinate. Off by default (whitepaper section 9). |
| `CONDUIT_ENABLE_EDITOR_EVAL` | `--enable-editor-eval` | *Flag.* Register `gd_editor_eval`, which runs arbitrary GDScript in the editor process with the editor's full authority over the project. Off by default. |
| `CONDUIT_DISABLE_EVAL` | `--disable-eval` | *Flag.* Drop the entire eval class: `gd_game_eval`, `gd_editor_eval`, the networking tools, and project-defined `gd_project_*` tools. Wins over the two opt-ins above. |
| `CONDUIT_TIMEOUT_MS` | `--timeout-ms <n>` | Timeout for an ordinary tool call, in milliseconds. Default 10000. |
| `CONDUIT_EVAL_TIMEOUT_MS` | `--eval-timeout-ms <n>` | Timeout for await-capable and eval-class calls: `gd_game_eval`, `gd_editor_eval`, `gd_project_*`, signal and frame waits, screenshots. Default 120000. |
| `CONDUIT_EXPORT_TIMEOUT_MS` | `--export-timeout-ms <n>` | Timeout for `gd_export_project`, which re-imports the whole project before packing. Default 600000. |
| `CONDUIT_AUDIT_LOG` | `--audit-log <path\|off>` | Append a JSONL record of every tool call to this file. Off unless set; `off` disables it explicitly. See [Audit log](#audit-log). |
| `CONDUIT_AUDIT_MAX_BYTES` | `--audit-max-bytes <n>` | Rotate the audit log once it passes this size. Default 16777216 (16 MiB). |
| `CONDUIT_TOOL_GROUPS` | `--tool-groups <list>` | Slim the tool surface to the named groups, or drop groups with `-name` entries. See [Tool groups](#tool-groups). |
| | `--version`, `--help` | Print the version or the option list to stderr and exit. |

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
| `CONDUIT_GODOT_DOCS` | `scripts/coverage/*` | Root of an offline Godot HTML documentation build (the directory holding `_sources/`), used by `bun run coverage` to regenerate `docs/coverage-matrix.md`. `--docs <dir>` overrides it. |
| `GODOT_VERSION` | `scripts/setup.ts`, CI workflows | Pin the Godot release tag `setup.ts` downloads, for example `4.7.1-stable`, instead of resolving the latest. |
| `TAG` | `scripts/check-version.ts` | The release tag to validate against the workspace `Cargo.toml` version. Set by the release workflow. |
| `GDRUST_SUPPRESSED_WARNINGS` | gdext, via `scripts/demo/record.ts` | Silences a named gdext warning during demo recording. Consumed by the dependency, not by Conduit. |

## Tool groups

The default surface is 86 tools, which is a lot of context for a client that
only needs some of it. `--tool-groups` slims it, in either of two forms:

```
--tool-groups scene,script,runtime    keep only these groups (plus core)
--tool-groups -net,-audio             keep everything except these
```

Mixing the forms is an error, as is naming a group that does not exist; both
messages list the valid groups. The groups are:

`runtime`, `tree`, `physics`, `render`, `audio`, `animation`, `tilemap`,
`window`, `net`, `scene`, `wiring`, `script`, `resource`, `project`, `state`,
`assets`, `files`, `export`, `debug`, `collab`, `classdb`, `eval`, `pixel`.

`core` is always registered and cannot be named: it holds `gd_ping`,
`gd_status`, `gd_game_list`, `gd_get_events`, and the session, addon, and engine
tools. A
deployment that had slimmed away `gd_status` could not be diagnosed, and one
without `gd_addon_install` could not be finished.

Groups only ever subtract from what the other flags already permit. Naming
`eval` does not reopen `--disable-eval`, and naming `pixel` does not substitute
for `--enable-pixel-tools`. Project-defined `gd_project_*` tools are not part of
any group; they appear and disappear with the running game and are governed by
`--disable-eval`.

## Audit log

`--audit-log <path>` appends one JSON object per line for every tool call:
time, tool name, arguments, outcome (`ok` or `error` with the error text),
the result, and duration in milliseconds. It exists for a human to review, or to
replay or bisect an agent session afterwards.

Payloads over 4 KiB are replaced with `<elided N bytes>` field by field, so a
`gd_screenshot` record keeps its outcome and timing without carrying a megabyte
of base64. The file rotates to `<path>.1` once it passes `--audit-max-bytes`,
keeping one previous generation. A write failure disables the log for that
session with one line on stderr and never interrupts the broker.

It is off by default. Whitepaper section 9 describes the log as something the
broker writes and can be disabled; Conduit inverts that, because writing a file
into someone's filesystem is not something to start doing unasked.

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

## Engine installation

The addon is Conduit's half of the pairing; the engine is Godot's. A machine
with no Godot at all leaves `gd_editor_launch` with nothing to launch, so
`gd_engine_install` fetches one from the Godot releases into
`CONDUIT_ENGINE_DIR` (`~/.conduit/engines` by default), one directory per build:

```
~/.conduit/engines/4.7.1-stable/           the standard build
~/.conduit/engines/4.7.1-stable-mono/      the .NET/C# build
```

Both builds of a version can coexist, because a C# project needs the .NET build
and a GDScript project does not. Pass `mono=true` (or `--godot-mono`) for it.

**Check before installing.** An editor that is already open is proof the machine
has an engine, and a Godot started without the Conduit opt-in does not show as
connected. `gd_engine_status` reports both: the resolved binary, and any Godot
process this broker did not start. `gd_editor_launch` refuses outright in that
case with `editor_running_unbridged`, because a second editor on one project is
worse than no editor at all - Godot expects to own `project.godot` for its
session. The fix is almost always to relaunch the editor the human already has
open with `--conduit`, whereupon the broker attaches to it.

Installs are marked with a `.conduit-engine` file written last, so an engine
Conduit did not install is never replaced without `force`, and an install
interrupted partway reads back as unmanaged rather than as good.

Downloads are verified against the `SHA512-SUMS.txt` published beside them
(SHA-512 here, unlike the addon's SHA-256). `CONDUIT_ENGINE_SOURCE` skips both
the download and the checksum, on the same terms as `CONDUIT_ADDON_SOURCE`.

Without `CONDUIT_AUTO_INSTALL_GODOT` nothing is ever downloaded unasked; the
variable only controls the unattended path, and calling `gd_engine_install`
yourself works regardless. Outside a session, `conduit-mcp-server
--install-godot` does the same thing and exits, and needs no `--project`.

With the variable set, the broker installs an engine at startup only when all
three of these hold, and each rules out a way the download would be wasted:

- no engine resolves at all (`PATH`, then the per-platform locations, then
  `CONDUIT_ENGINE_DIR`);
- no editor bridge is connected, which would prove an engine exists whatever
  resolution thinks;
- no editor is running that the broker did not start, because that means Godot
  is open without the opt-in and the fix is to relaunch it, not to download a
  second engine.

It runs after the MCP handshake, so a slow download never delays the client, and
`--godot-version` and `--godot-mono` choose what it fetches. Progress and
failure reach the agent as `engine_install_started`, `engine_installed`, and
`engine_install_failed` events rather than only as log lines.

## Example

A typical MCP client entry needs none of these:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "conduit-mcp-server@0.7.3", "--project", "/absolute/path/to/your-godot-project"]
    }
  }
}
```

Pin the version rather than tracking the latest. An unpinned `npx` or `bunx`
reaches the npm registry on every server start, which spends part of the startup
budget your MCP client is holding a timeout over, and it lets the broker drift
away from the addon installed in the project.

Run one broker per project. The bridge serves a single client at a time, so a
second entry for a project that already has a server connects and then waits for
a handshake the bridge is not free to send. `gd_status` reports that case
specifically rather than leaving it as a bare disconnection.

A first-run entry that installs the addon and enables game-side tools:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "conduit-mcp-server@0.7.3", "--project", "/absolute/path/to/your-godot-project"],
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
