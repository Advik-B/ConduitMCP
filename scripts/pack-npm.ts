#!/usr/bin/env bun
// Stage the broker as a publishable npm package under dist/npm.
//
// The broker cannot be published from broker/ directly: it imports the
// workspace Cargo.toml from outside its own directory, which no npm tarball can
// carry, and scripts/check-version.ts forbids a version field in either
// committed package.json so the workspace Cargo.toml stays the single source of
// the version. Bundling resolves both: the TOML import is inlined as a literal,
// and the version is stamped into a package.json generated here rather than
// committed. Run with `bun scripts/pack-npm.ts`.

import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const outDir = join(repoRoot, "dist", "npm");

const PACKAGE_NAME = "conduit-mcp-server";
const REPO_URL = "https://github.com/Advik-B/ConduitMCP";

function cargoTomlVersion(): string {
  const text = readFileSync(join(repoRoot, "Cargo.toml"), "utf8");
  const match = text.match(/^\[workspace\.package\][^[]*?^version = "([^"]+)"/ms);
  if (!match?.[1]) {
    throw new Error("no workspace.package version in Cargo.toml");
  }
  return match[1];
}

// import.meta.main is a Bun extension. Under --target=node it lowers to a
// __require reference that is undefined in ESM output, so the bundled server
// would crash on start. The guard has to stay in source because
// broker/tests/tools.test.ts imports registerTools from the same module and
// must not boot a server; defining it true here is correct only for this
// bundle, whose sole purpose is being the entry point.
async function bundle(entry: string, outfile: string): Promise<void> {
  const proc = Bun.spawn(
    ["bun", "build", entry, "--target=node", "--define", "import.meta.main=true", "--outfile", outfile],
    { cwd: repoRoot, stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`bun build failed (${code})`);
  }
}

function readme(version: string): string {
  return `# conduit-mcp-server

The MCP stdio server for [Conduit](${REPO_URL}), which gives an AI agent native
control of the Godot editor and the running game.

## This package is one half of Conduit

The server alone does nothing. It connects over local IPC to a Rust GDExtension
that has to live in your Godot project. Set \`CONDUIT_AUTO_INSTALL=1\` in the
config below and the server installs it for you: pointed at a Godot project with
no addon, it downloads the \`v${version}\` addon matching this package, writes it
to \`addons/conduit/\`, and registers the \`ConduitRuntime\` autoload in
\`project.godot\` (backing that file up first). Then open the project in Godot so
the extension loads. The agent can also run it on demand with
\`gd_addon_install\`, and \`gd_addon_status\` reports what is installed.

To install it yourself instead:

1. Download \`conduit-addon-v${version}.zip\` from
   [Releases](${REPO_URL}/releases) and extract it into your project root, so the
   files land under \`addons/conduit/\`.
2. Open the project once so Godot loads the extension.
3. For game-side tools (play, input, screenshots), add the runtime autoload:
   Project Settings, Globals, Autoload, add
   \`res://addons/conduit/conduit_runtime.tscn\` named \`ConduitRuntime\`.

On macOS, a hand-extracted zip is quarantined; clear it with
\`xattr -dr com.apple.quarantine addons/conduit\`. Files the server writes itself
are not quarantined.

Either way, keep the addon on \`v${version}\` to match this package. The addon zip
and this package are released together from the same tag, and a mismatched pair
is the first thing to suspect if tools are missing or a call fails to route;
\`gd_status\` reports the pair as \`stale\` when they disagree.

## Configure your MCP client

Nothing to install ahead of time: point your MCP client at the package and it is
fetched on first run. Claude Code (\`.mcp.json\` in your project) and Claude
Desktop (\`claude_desktop_config.json\`) use the same entry:

\`\`\`json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "${PACKAGE_NAME}", "--project", "/absolute/path/to/your-godot-project"],
      "env": {
        "CONDUIT_AUTO_INSTALL": "1",
        "CONDUIT_ENABLE": "1"
      }
    }
  }
}
\`\`\`

On Bun, use \`bunx\` as the \`command\` and drop the \`-y\`. To stay on a known pair
rather than tracking the latest, pin the version: \`${PACKAGE_NAME}@${version}\`.

The project path is all the server needs; both environment variables are
optional. \`CONDUIT_AUTO_INSTALL=1\` installs the addon as described above and
does nothing once it is current. \`CONDUIT_ENABLE=1\` lets the game-side bridge
activate in games launched from an editor the broker started.

You do not need to tell Conduit where Godot is. Attaching to an editor uses a
local endpoint, never an engine binary, and \`gd_editor_launch\` finds the binary
on \`PATH\` and in the usual install locations by itself.

Editor-side tools need no opt-in: the broker finds any running editor for the
configured project automatically.

## Install as a Claude Code plugin instead

This package is also a Claude Code plugin, which configures the server and
installs the agent skill in one step, with no config file to edit:

\`\`\`
/plugin marketplace add Advik-B/ConduitMCP
/plugin install conduit@conduit
\`\`\`

The skill is what makes the tool surface usable without trial and error: which
of the two bridges each tool routes to, edit-time versus runtime node paths, the
tagged Variant encoding, what each error code means, and the ordering rules that
produce dead ends.

For any other MCP client, use the \`mcpServers\` entry above and copy the skill
directory yourself:

\`\`\`
cp -r node_modules/${PACKAGE_NAME}/skills/godot-conduit .claude/skills/
\`\`\`

With \`npx\` there is no \`node_modules\` to copy from; take it from
[the repository](${REPO_URL}/tree/master/skills/godot-conduit) instead. Keep it on
the same version as the server: it documents that version's tool surface.

## No Godot on the machine

\`conduit-mcp-server --install-godot\` downloads a Godot editor into
\`~/.conduit/engines\` and exits; the broker then finds it by itself. Add
\`--godot-mono\` for the .NET build if the project uses C#. The agent can do the
same mid-session with \`gd_engine_install\`.

Check \`gd_engine_status\` before either: an editor the human already has open
needs no engine, and Conduit refuses to open a second editor on a project that
already has one.

## Requirements

- Godot 4.4 or newer.
- Node.js 20 or newer (tested on 22), or Bun 1.2 or newer.
- Prebuilt bridge platforms: Windows x64, Linux x64 (glibc 2.35+), macOS
  universal.

For a machine with neither Node nor Bun, a standalone binary of this same server
is published on [Releases](${REPO_URL}/releases); use its absolute path as the
\`command\` instead.

## Flags

Run \`npx ${PACKAGE_NAME} --help\` for the full list; every option has a
\`CONDUIT_\` environment variable equivalent, and the option wins.

| Flag | Env | Effect |
| --- | --- | --- |
| \`--project <path>\` | \`CONDUIT_PROJECT\` | The Godot project to attach to (required, or \`--sock\`). |
| \`--auto-install\` | \`CONDUIT_AUTO_INSTALL\` | Install the matching addon into the project if it has none (off by default). |
| \`--addon-source <path>\` | \`CONDUIT_ADDON_SOURCE\` | Install the addon from a local zip, directory, or URL instead of the release. |
| \`--godot <path>\` | \`CONDUIT_GODOT\` | Override the engine binary for \`gd_editor_launch\`; found automatically otherwise. |
| \`--install-godot\` | | Download and install a Godot engine, then exit. \`--godot-version <tag>\` picks the release, \`--godot-mono\` the .NET/C# build. Needs no \`--project\`. |
| \`--auto-install-godot\` | \`CONDUIT_AUTO_INSTALL_GODOT\` | Allow an engine to be installed unasked when none is found (off by default). |
| \`--engine-dir <path>\` | \`CONDUIT_ENGINE_DIR\` | Where installed engines live, default \`~/.conduit/engines\`; \`--engine-source\` installs from a local zip or directory. |
| \`--enable-pixel-tools\` | \`CONDUIT_ENABLE_PIXEL_TOOLS\` | Enable coordinate-level editor mouse tools (off by default). |
| \`--enable-editor-eval\` | \`CONDUIT_ENABLE_EDITOR_EVAL\` | Enable \`gd_editor_eval\` (off by default). |
| \`--disable-eval\` | \`CONDUIT_DISABLE_EVAL\` | Drop the whole eval class of tools. |
| \`--tool-groups <list>\` | \`CONDUIT_TOOL_GROUPS\` | Slim the tool surface: \`scene,runtime\` keeps those groups, \`-net,-audio\` drops them. |
| \`--audit-log <path>\` | \`CONDUIT_AUDIT_LOG\` | Append a JSONL record of every tool call (off by default); \`--audit-max-bytes\` sets the rotation size. |
| \`--timeout-ms <n>\` | \`CONDUIT_TIMEOUT_MS\` | Ordinary tool timeout, default 10000; also \`--eval-timeout-ms\` and \`--export-timeout-ms\`. |
| \`--runtime-dir\`, \`--sock\`, \`--tcp\` | \`CONDUIT_RUNTIME_DIR\`, \`CONDUIT_SOCK\`, \`CONDUIT_TCP\` | Where the broker and bridge meet; rarely needed. |

Boolean variables are off when unset, empty, \`0\`, \`false\`, \`no\`, or \`off\`, and
on for anything else. Flags with a \`--no-\` form override the variable the other
way.

Every variable Conduit reads, including the transport and engine-side ones, is
documented in [docs/environment.md](${REPO_URL}/blob/master/docs/environment.md).
Full documentation, including the safety model and the tool reference, is in the
[repository](${REPO_URL}).

## License

MIT
`;
}

async function main(): Promise<void> {
  const version = cargoTomlVersion();

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const entryFile = join(outDir, "index.js");
  await bundle(join(repoRoot, "broker", "src", "index.ts"), entryFile);

  // The source shebang targets Bun. The bundle runs on stock Node, and a node
  // shebang works for both npx and bunx consumers.
  const bundled = readFileSync(entryFile, "utf8");
  if (!bundled.startsWith("#!")) {
    throw new Error("bundle lost its shebang");
  }
  writeFileSync(entryFile, bundled.replace(/^#![^\n]*/, "#!/usr/bin/env node"));

  // No dependencies: the MCP SDK and zod are inlined by the bundler, so
  // declaring them would make consumers install them a second time.
  const manifest = {
    name: PACKAGE_NAME,
    version,
    description: "MCP stdio server giving an AI agent native control of the Godot editor and running game",
    keywords: ["mcp", "godot", "gamedev", "ai", "model-context-protocol"],
    homepage: REPO_URL,
    repository: { type: "git", url: `git+${REPO_URL}.git` },
    bugs: { url: `${REPO_URL}/issues` },
    license: "MIT",
    type: "module",
    bin: { [PACKAGE_NAME]: "index.js" },
    files: ["index.js", "README.md", "LICENSE", "skills", ".mcp.json", ".claude-plugin"],
    engines: { node: ">=20" },
  };
  writeFileSync(join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // The same tarball is also a Claude Code plugin: a manifest plus an .mcp.json
  // makes installing the plugin configure the server and install the skill in
  // one step, instead of editing a config file and copying a directory by hand.
  // Both are generated rather than committed so the version can only ever come
  // from the workspace Cargo.toml.
  mkdirSync(join(outDir, ".claude-plugin"), { recursive: true });
  const plugin = {
    name: "conduit",
    description: manifest.description,
    version,
    homepage: REPO_URL,
    repository: REPO_URL,
    license: "MIT",
    keywords: manifest.keywords,
  };
  writeFileSync(join(outDir, ".claude-plugin", "plugin.json"), `${JSON.stringify(plugin, null, 2)}\n`);

  // CLAUDE_PLUGIN_ROOT points at the installed package, so the server runs the
  // copy that shipped with this plugin rather than resolving one from the
  // registry. CLAUDE_PROJECT_DIR assumes the workspace root is the Godot
  // project; when it is not, the user overrides --project.
  const mcp = {
    mcpServers: {
      conduit: {
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/index.js", "--project", "${CLAUDE_PROJECT_DIR}"],
      },
    },
  };
  writeFileSync(join(outDir, ".mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`);

  copyFileSync(join(repoRoot, "LICENSE"), join(outDir, "LICENSE"));
  writeFileSync(join(outDir, "README.md"), readme(version));

  // The agent skill ships with the server so a consumer gets both halves of what
  // makes the tool surface usable. evals/ is a tuning artifact for the skill, not
  // part of the skill, and skill tooling excludes it too.
  cpSync(join(repoRoot, "skills"), join(outDir, "skills"), {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/).includes("evals"),
  });

  console.log(`staged ${PACKAGE_NAME} ${version} in ${outDir}`);
  // Tagged releases publish from the release workflow over OIDC. This manual
  // path is for the first publish, before a trusted publisher can be registered.
  console.log(`first publish (token auth): cd ${join("dist", "npm")} && bun publish`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
