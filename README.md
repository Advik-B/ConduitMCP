# Conduit

[![CI](https://github.com/Advik-B/ConduitMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/Advik-B/ConduitMCP/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Advik-B/ConduitMCP)](https://github.com/Advik-B/ConduitMCP/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Conduit gives an AI agent full, native control of the Godot editor and the running game. It is not a file-level integration: a Rust GDExtension loads into the Godot process itself, so the agent edits scenes undo-safely inside a live editor, presses play, watches frames, injects input, sets breakpoints, and inspects the halted game, through one MCP server.

![The Godot editor showing a 2D platformer scene assembled by an agent through Conduit's editing tools](docs/media/editor-agent-scene.png)

The scene above was built by an agent through Conduit's undo-wrapped editing tools; every change lands in the editor's undo history exactly as if a human had made it, while the developer watches it happen in their own editor.

## How it works

Two pieces:

- **Bridge**: a Rust GDExtension (`addons/conduit/`) loaded by the Godot editor and by the game it launches. The same library runs in both contexts: the editor bridge speaks the editor's own APIs (undo/redo, scene docks, the debugger plugin), the game bridge works the live scene tree.
- **Broker**: a single-binary MCP stdio server your MCP client launches. It connects to both bridges over local IPC (named pipe on Windows, Unix socket elsewhere) and presents them as one tool surface.

Nothing listens on the network, and the bridge refuses to activate in release builds, so shipping a game with the addon installed never ships a code-execution listener. The full design is in the [whitepaper](docs/conduit-whitepaper.md).

## What the agent can do

87 tools, 82 exposed by default and the rest behind opt-in flags. The broad strokes:

- **Edit scenes the way the editor does**: open, create, and save scenes; add, remove, reparent, rename, and duplicate nodes; set properties with full Godot typing (vectors, colors, resources); attach and validate scripts; wire signals and groups; manage autoloads and the input map. Every mutation is undo-wrapped, so one `gd_undo` reverses it and the developer's undo history stays coherent.
- **Run and observe the game**: `gd_play` launches the game and connects its bridge; then the agent reads and writes live node properties, calls methods, simulates keyboard, mouse, gamepad, and touch input, waits precise frame counts, pauses and steps, reads logs and errors, and captures screenshots of what the game actually rendered.

![A space scene assembled at runtime inside the running game by gd_game_eval, captured with gd_screenshot](docs/media/game-screenshot.png)

  That frame is the game's own rendering, captured with `gd_screenshot`. The scene in it was assembled at runtime by `gd_game_eval`, and the ship sits mid-flight because the agent was holding a movement action through `gd_input` when it took the shot.

- **Debug interactively**: set breakpoints, trigger them with simulated input, then read the call stack and frame variables, step over and into, and continue, through the editor's own debugger.

![The editor halted at a breakpoint in player.gd with the call stack and locals visible](docs/media/debugger-break.png)

- **Ground itself in the engine**: query ClassDB for any class's properties, methods, and signals, so the agent works from the engine's actual API surface instead of guessing.
- **Stay legible to the human**: select and inspect nodes in the developer's editor, open scripts at a line, observe and dismiss dialogs, and capture editor screenshots, so a person watching the editor can follow what the agent is doing.
- **Expose project-defined tools**: methods on nodes in a `conduit_tools` group appear as first-class MCP tools with typed schemas, so a project can teach the agent verbs like `gd_project_spawn_wave`.

## Requirements

- Godot 4.4 or newer (developed and tested against 4.7.1).
- Prebuilt bridge platforms: Windows x64, Linux x64 (glibc 2.35+), macOS universal (Intel and Apple silicon).
- The broker binary is standalone; nothing else to install. Running from source instead needs [Bun](https://bun.sh) 1.2+.
- Any MCP client: Claude Code, Claude Desktop, or anything else that speaks MCP over stdio.

## Install the addon

1. Download `conduit-addon-vX.Y.Z.zip` from [Releases](https://github.com/Advik-B/ConduitMCP/releases) and extract it into your project root, so the files land under `addons/conduit/`.
2. Open the project once so Godot loads the extension. Editor-side tools work from here.
3. For game-side tools (play, input, screenshots, eval), add the runtime autoload: Project Settings, Globals, Autoload, add `res://addons/conduit/conduit_runtime.tscn` with the name `ConduitRuntime`.

On macOS, clear the quarantine attribute after extracting: `xattr -dr com.apple.quarantine addons/conduit`.

## Run the broker

Download the broker binary for your platform from [Releases](https://github.com/Advik-B/ConduitMCP/releases) (`conduit-mcp-server-windows-x64.exe`, `conduit-mcp-server-linux-x64`, `conduit-mcp-server-darwin-arm64`, or `conduit-mcp-server-darwin-x64`). On Linux and macOS make it executable (`chmod +x`), and on macOS clear quarantine (`xattr -d com.apple.quarantine <binary>`).

Then register it with your MCP client. Claude Code (`.mcp.json` in your project, or `claude mcp add`):

```json
{
  "mcpServers": {
    "godot": {
      "command": "/absolute/path/to/conduit-mcp-server",
      "args": ["--project", "/absolute/path/to/your-godot-project"],
      "env": {
        "CONDUIT_ENABLE": "1",
        "CONDUIT_GODOT": "/absolute/path/to/godot"
      }
    }
  }
}
```

Claude Desktop uses the same entry under `mcpServers` in `claude_desktop_config.json`.

The two environment variables are optional but recommended:

- `CONDUIT_ENABLE=1` lets the game-side bridge activate in games launched from an editor the broker started (`gd_editor_launch`). If you launch the editor yourself and want game-side tools, start it with this variable set: `CONDUIT_ENABLE=1 godot --editor --path .`
- `CONDUIT_GODOT` tells the broker which engine binary `gd_editor_launch` and `gd_project_scaffold` should use. Without it the agent can still attach to an editor you opened yourself.

Editor-side tools need no opt-in: the broker finds any running editor for the configured project automatically.

Running from a clone instead of the binary: `bun install --frozen-lockfile`, then use `bun /path/to/repo/broker/src/index.ts` as the `command` with the same args. The broker is not published to npm yet.

## Flags and safety

The broker's full configuration surface:

| Flag | Env | Effect |
| --- | --- | --- |
| `--project <path>` | `CONDUIT_PROJECT` | The Godot project to attach to (required, or `CONDUIT_SOCK`). |
| `--godot <path>` | `CONDUIT_GODOT` | Engine binary for `gd_editor_launch` and `gd_project_scaffold`. |
| `--enable-pixel-tools` | `CONDUIT_ENABLE_PIXEL_TOOLS` | Enable coordinate-level editor mouse tools (off by default). |
| `--enable-editor-eval` | `CONDUIT_ENABLE_EDITOR_EVAL` | Enable `gd_editor_eval`, GDScript in the editor process (off by default). |
| `--disable-eval` | `CONDUIT_DISABLE_EVAL` | Drop the whole eval class: `gd_game_eval`, `gd_editor_eval`, networking tools, project-defined tools. |

The safety properties are structural, not configuration:

- Bridge and broker talk over local IPC only. The broker's only external interface is MCP on stdio; no TCP port is opened by default.
- The bridge listener never activates in a release build, enforced in code and covered by a test. Release export presets additionally exclude the bridge binaries.
- In a game process (debug builds included) the bridge activates only with an explicit opt-in: the `--conduit` user argument or `CONDUIT_ENABLE`.
- File tools are confined to `res://` and `user://` paths.

## Building from source

Rust stable (edition 2024) and Bun 1.2+:

```
cargo build --release
bun install --frozen-lockfile
```

The bridge library lands in `target/release/`; `bridge/conduit.gdextension` shows the development-layout manifest that loads it straight from the cargo target directory. `bun test` in `broker/` runs the broker unit tests; the `tests/evals/` phase runners are integration acceptance tests that drive a real Godot editor (see `scripts/setup.ts` for fetching a pinned engine build). `scripts/capture-media.ts` regenerates the screenshots above through Conduit's own screenshot tools.

## Status and compatibility

All nine roadmap phases of the [whitepaper](docs/conduit-whitepaper.md) are implemented, with scripted acceptance checks per phase. Tested pairing: Godot 4.7.1 with gdext 0.5.4; the addon declares `compatibility_minimum 4.4`. Platform notes and known engine API gaps are tracked in [docs/api-gaps.md](docs/api-gaps.md).

## License

[MIT](LICENSE)
