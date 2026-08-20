# Conduit

[![CI](https://github.com/Advik-B/ConduitMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/Advik-B/ConduitMCP/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Advik-B/ConduitMCP)](https://github.com/Advik-B/ConduitMCP/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Conduit gives an AI agent full, native control of the Godot editor and the running game. It is not a file-level integration: a Rust GDExtension loads into the Godot process itself, so the agent edits scenes undo-safely inside a live editor, presses play, watches frames, injects input, sets breakpoints, and inspects the halted game, through one MCP server.

## Watch it work

![An agent building a level in the Godot editor through Conduit: nodes appear in the scene dock, a script is written and attached, the level is dismantled by undo and rebuilt by redo, the game runs and is driven by simulated input, and the editor halts at a breakpoint](docs/media/demo.gif)

One editor session, recorded end to end: [the full take is `docs/media/demo.mp4`](docs/media/demo.mp4), around 1 min 45 s. It runs at real speed with no cuts, and the loop above is a few seconds lifted from each chapter of that same recording. Every caption is the MCP tool call being made at that moment. The sequence of calls is scripted so the video is reproducible from a checkout rather than different every take, but the calls themselves are the ordinary MCP tool surface with no opt-in flags, and what you see is a real editor responding to them.

1. **Building a scene through the editor's own API**: a new scene, then a level assembled node by node with typed properties, the scene dock and inspector following along.
2. **Writing a script, checking it compiles, attaching it**: `gd_script_create`, `gd_script_validate`, `gd_script_attach`, then the script open in the editor at the line that matters.
3. **Signals, groups, the input map, and a saved scene**: the wiring that turns a scene into a game, all persisted.
4. **Every edit is in the editor's own undo history**: repeated `gd_undo` takes the level apart node by node until nothing is left, then `gd_redo` puts it back. This is what a file-level integration cannot do.
5. **Running the game and driving it with simulated input**: `gd_play`, a held movement action, live property reads off the running node, time scale.
6. **The project's own methods, surfaced as MCP tools**: a node in the `conduit_tools` group turns `spawn_coins` into `gd_project_spawn_coins`, and calling it spawns coins in the running game.
7. **A breakpoint, tripped by the agent, read in the editor**: the game halts on `player.gd:24`, and the call stack, locals, and remote inspector are all there.
8. **What is left behind is an ordinary Godot project**: a normal `.tscn` and normal `.gd` files, in the project where a human would have put them.

Reproduce it with `bun run demo`, which drives a throwaway copy of `example-project/` and regenerates both files (Linux only; see [docs/api-gaps.md](docs/api-gaps.md)).

## How it works

Two pieces:

- **Bridge**: a Rust GDExtension (`addons/conduit/`) loaded by the Godot editor and by the game it launches. The same library runs in both contexts: the editor bridge speaks the editor's own APIs (undo/redo, scene docks, the debugger plugin), the game bridge works the live scene tree.
- **Broker**: a single-binary MCP stdio server your MCP client launches. It connects to both bridges over local IPC (named pipe on Windows, Unix socket elsewhere) and presents them as one tool surface.

Nothing listens on the network, and the bridge refuses to activate in release builds, so shipping a game with the addon installed never ships a code-execution listener. The full design is in the [whitepaper](docs/conduit-whitepaper.md).

## What the agent can do

100 tools, 95 exposed by default and the rest behind opt-in flags. The broad strokes:

- **Edit scenes the way the editor does**: open, create, and save scenes; add, remove, reparent, rename, and duplicate nodes; set properties with full Godot typing (vectors, colors, resources); attach and validate scripts; wire signals and groups; manage autoloads and the input map. Every mutation is undo-wrapped, so one `gd_undo` reverses it and the developer's undo history stays coherent.

![The Godot editor showing a 2D platformer scene assembled by an agent through Conduit's editing tools](docs/media/editor-agent-scene.png)

- **Run and observe the game**: `gd_play` launches the game and connects its bridge; then the agent reads and writes live node properties, calls methods, simulates keyboard, mouse, gamepad, and touch input, waits precise frame counts, pauses and steps, reads logs and errors, and captures screenshots of what the game actually rendered.

![A space scene assembled at runtime inside the running game by gd_game_eval, captured with gd_screenshot](docs/media/game-screenshot.png)

  That frame is the game's own rendering, captured with `gd_screenshot`. The scene in it was assembled at runtime by `gd_game_eval`, and the ship sits mid-flight because the agent was holding a movement action through `gd_input` when it took the shot.

- **Debug interactively**: set breakpoints, trigger them with simulated input, then read the call stack and frame variables, step over and into, and continue, through the editor's own debugger.

![The editor halted at a breakpoint in player.gd with the call stack and locals visible](docs/media/debugger-break.png)

- **Ground itself in the engine**: query ClassDB for any class's properties, methods, and signals, so the agent works from the engine's actual API surface instead of guessing.
- **Hold engine objects that have no name**: a `SurfaceTool`, a physics query, an unsaved sub-resource, a space state. `gd_object` and `gd_scene_object` hand back a handle, and `capture` takes one on whatever a call returned, so the agent can build an object over several calls or pass one method's result into another's arguments without writing GDScript.
- **Stay legible to the human**: select and inspect nodes in the developer's editor, open scripts at a line, observe and dismiss dialogs, and capture editor screenshots, so a person watching the editor can follow what the agent is doing. A toolbar indicator shows the link state, the editor's Output log carries a line per undo-wrapped action, and a Conduit bottom panel lists the tool-call history.
- **Expose project-defined tools**: methods on nodes in a `conduit_tools` group appear as first-class MCP tools with typed schemas, so a project can teach the agent verbs like `gd_project_spawn_wave`.

## Requirements

- Godot 4.4 or newer (developed and tested against 4.7.1).
- Prebuilt bridge platforms: Windows x64, Linux x64 (glibc 2.35+), macOS universal (Intel and Apple silicon).
- Node.js 20+ (tested on 22) or [Bun](https://bun.sh) 1.2+, to run the broker from npm. A standalone binary that needs neither is on [Releases](https://github.com/Advik-B/ConduitMCP/releases).
- Any MCP client: Claude Code, Claude Desktop, or anything else that speaks MCP over stdio.

## Install the addon

Conduit is two halves: the MCP server below, and a GDExtension that lives in your Godot project. Let the broker install that half for you, or do it by hand.

**Automatically.** Set `CONDUIT_AUTO_INSTALL=1` in the MCP client entry (see below). Pointed at a Godot project with no addon, the broker downloads the addon matching its own version, writes it to `addons/conduit/`, and registers the `ConduitRuntime` autoload in `project.godot`, backing that file up first. Then open the project in Godot. The agent can also do it on request with `gd_addon_install`, and `gd_addon_status` reports what is installed. Godot only loads a GDExtension at startup, so installing is refused while the editor is open.

**By hand.**

1. Download `conduit-addon-vX.Y.Z.zip` from [Releases](https://github.com/Advik-B/ConduitMCP/releases) and extract it into your project root, so the files land under `addons/conduit/`.
2. Open the project once so Godot loads the extension. Editor-side tools work from here.
3. For game-side tools (play, input, screenshots, eval), add the runtime autoload: Project Settings, Globals, Autoload, add `res://addons/conduit/conduit_runtime.tscn` with the name `ConduitRuntime`.

On macOS, a zip extracted by hand is quarantined; clear it with `xattr -dr com.apple.quarantine addons/conduit`. Files the broker writes itself are not quarantined, so an automatic install needs no such step.

## Run the broker

The broker is on npm as [`conduit-mcp-server`](https://www.npmjs.com/package/conduit-mcp-server). There is nothing to install ahead of time: point your MCP client at it and the package is fetched on first run.

Claude Code (`.mcp.json` in your project, or `claude mcp add`):

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

On Bun, use `bunx` as the `command` and drop the `-y`.

The version is pinned on purpose. An unpinned `npx` or `bunx` re-resolves the package against the npm registry every time your client starts the server, which adds network time to a startup your client is holding a timeout over, and it lets the broker drift away from the addon version installed in your project. Bump both together.

**Run one broker per project.** The bridge serves a single client at a time, so a second MCP server entry pointed at a project that already has one can never attach: it connects, waits for a handshake the bridge is not free to send, and reports the editor as unavailable. If you installed the Claude Code plugin below, you already have a server for that project and do not need this entry as well. `gd_status` names this case when it happens.

Claude Desktop uses the same entry under `mcpServers` in `claude_desktop_config.json`.

The project path is the only thing the broker needs. Both environment variables are optional:

- `CONDUIT_AUTO_INSTALL=1` installs the addon into the project if it is not there yet. Drop it once the addon is installed, or leave it: it does nothing when the addon is already current.
- `CONDUIT_ENABLE=1` lets the game-side bridge activate in games launched from an editor the broker started (`gd_editor_launch`). If you launch the editor yourself and want game-side tools, start it with this variable set: `CONDUIT_ENABLE=1 godot --editor --path .` on Linux and macOS, or `$env:CONDUIT_ENABLE=1; godot --editor --path .` in PowerShell.

You do not need to tell Conduit where Godot is. Attaching never uses an engine binary at all: the broker finds a running editor for the configured project by its local endpoint. `gd_editor_launch`, the one tool that starts an editor itself, looks for the binary on `PATH` and in the usual install locations; `CONDUIT_GODOT` overrides that if your Godot lives somewhere unusual.

Editor-side tools need no opt-in: the broker finds any running editor for the configured project automatically.

Keep the broker and the addon on the same version. The npm package and the addon zip are released together from the same tag, so an `X.Y.Z` addon expects an `X.Y.Z` broker; pinning the version in `args` is the simplest way to keep them in step.

## One-step install for Claude Code

The npm package is also a Claude Code plugin, which configures the server and installs the agent skill together, with no config file to edit:

```
/plugin marketplace add Advik-B/ConduitMCP
/plugin install conduit@conduit
```

The skill is the half that makes the tool surface usable without trial and error: which of the two bridges each tool routes to, edit-time versus runtime node paths, the tagged Variant encoding, what each error code means, and the ordering rules that produce dead ends (install the addon with no editor running, validate a script before attaching it, save before playing). For any other MCP client, use the `mcpServers` entry above and copy the skill yourself with `cp -r node_modules/conduit-mcp-server/skills/godot-conduit .claude/skills/`, or take `skills/godot-conduit/` out of this repository if you run it through `npx`. Keep it on the same version as the broker; it documents that version's tools.

## No Godot installed?

`conduit-mcp-server --install-godot` downloads a Godot editor into `~/.conduit/engines` and exits, and the broker finds it from then on. Add `--godot-mono` for the .NET build if the project uses C#; both builds of a version can live side by side. An agent can do the same mid-session with `gd_engine_install`.

Check `gd_engine_status` first, though. An editor you already have open needs no engine, and Conduit will not open a second editor on a project that already has one: a Godot started without the `--conduit` opt-in does not appear as connected, and launching over it puts two editors on a `project.godot` that Godot expects to own for its session. Relaunch the one you have with the opt-in and the broker attaches to it.

Two alternatives to npm, if you want them:

- **Standalone binary**, for a machine with neither Node nor Bun. Download it for your platform from [Releases](https://github.com/Advik-B/ConduitMCP/releases) (`conduit-mcp-server-windows-x64.exe`, `conduit-mcp-server-linux-x64`, `conduit-mcp-server-darwin-arm64`, or `conduit-mcp-server-darwin-x64`), `chmod +x` it on Linux and macOS, clear quarantine on macOS (`xattr -d com.apple.quarantine <binary>`), and use its absolute path as the `command` with `args: ["--project", "..."]`.
- **From a clone**, for working on Conduit itself: `bun install --frozen-lockfile`, then `bun /path/to/repo/broker/src/index.ts` as the `command` with the same args.

## Flags and safety

Run `conduit-mcp-server --help` for the full option list, or read [docs/environment.md](docs/environment.md), which documents every variable Conduit reads including the transport and engine-side ones. Command-line options override the matching environment variable.

| Flag | Env | Effect |
| --- | --- | --- |
| `--project <path>` | `CONDUIT_PROJECT` | The Godot project to attach to (required, or `--sock`). |
| `--auto-install` | `CONDUIT_AUTO_INSTALL` | Install the matching addon into the project if it has none (off by default). |
| `--addon-source <path>` | `CONDUIT_ADDON_SOURCE` | Install the addon from a local zip, directory, or URL instead of the GitHub release. |
| `--godot <path>` | `CONDUIT_GODOT` | Override the engine binary for `gd_editor_launch`; found automatically otherwise. |
| `--install-godot` | | Download and install a Godot engine, then exit. `--godot-version <tag>` picks the release, `--godot-mono` the .NET/C# build. Needs no `--project`. |
| `--auto-install-godot` | `CONDUIT_AUTO_INSTALL_GODOT` | Allow an engine to be installed unasked when none is found (off by default). Separate from `--auto-install`: an engine is a 60-200 MB machine-wide download. |
| `--engine-dir <path>` | `CONDUIT_ENGINE_DIR` | Where installed engines live, default `~/.conduit/engines`. `--engine-source` installs from a local zip or directory instead of downloading. |
| `--enable-pixel-tools` | `CONDUIT_ENABLE_PIXEL_TOOLS` | Enable coordinate-level editor mouse tools (off by default). |
| `--enable-editor-eval` | `CONDUIT_ENABLE_EDITOR_EVAL` | Enable `gd_editor_eval`, GDScript in the editor process (off by default). |
| `--disable-eval` | `CONDUIT_DISABLE_EVAL` | Drop the whole eval class: `gd_game_eval`, `gd_editor_eval`, networking tools, project-defined tools. |
| `--tool-groups <list>` | `CONDUIT_TOOL_GROUPS` | Slim the tool surface: `scene,runtime` keeps those groups, `-net,-audio` drops them. |
| `--audit-log <path>` | `CONDUIT_AUDIT_LOG` | Append a JSONL record of every tool call (off by default); `--audit-max-bytes` sets the rotation size. |
| `--timeout-ms <n>` | `CONDUIT_TIMEOUT_MS` | Ordinary tool timeout, default 10000. `--eval-timeout-ms` (120000) covers eval and await, `--export-timeout-ms` (600000) covers export. |
| `--runtime-dir`, `--sock`, `--tcp` | `CONDUIT_RUNTIME_DIR`, `CONDUIT_SOCK`, `CONDUIT_TCP` | Where the broker and bridge meet. Rarely needed; see the reference. |

Boolean variables are off when unset, empty, `0`, `false`, `no`, or `off`, and on for anything else. Boolean flags with a `--no-` form (`--no-auto-install`, `--no-tcp`) override the variable in the other direction.

The safety properties are structural, not configuration:

- Bridge and broker talk over local IPC only. The broker's only external interface is MCP on stdio; no TCP port is opened by default.
- The bridge listener never activates in a release build, enforced in code and covered by a test. Release export presets additionally exclude the bridge binaries.
- In a game process (debug builds included) the bridge activates only with an explicit opt-in: the `--conduit` user argument (or the bare form `conduit`) or `CONDUIT_ENABLE`.
- File tools are confined to `res://` and `user://` paths.

## Building from source

Rust stable (edition 2024) and Bun 1.2+:

```
cargo build --release
bun install --frozen-lockfile
```

The bridge library lands in `target/release/`; `bridge/conduit.gdextension` shows the development-layout manifest that loads it straight from the cargo target directory. `bun test` in `broker/` runs the broker unit tests; the `tests/evals/` phase runners are integration acceptance tests that drive a real Godot editor (see `scripts/setup.ts` for fetching a pinned engine build). `scripts/capture-media.ts` regenerates the screenshots above through Conduit's own screenshot tools, and `bun run demo` (`scripts/demo/`) re-records the video at the top by driving a live editor while capturing the display it renders to.

## Status and compatibility

All nine roadmap phases of the [whitepaper](docs/conduit-whitepaper.md) are implemented, with scripted acceptance checks per phase. Tested pairing: Godot 4.7.1 with gdext 0.5.5; the addon declares `compatibility_minimum 4.4`. Platform notes and known engine API gaps are tracked in [docs/api-gaps.md](docs/api-gaps.md).

## License

[MIT](LICENSE)
