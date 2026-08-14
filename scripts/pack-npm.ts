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

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
that must be installed into your Godot project first. Install the addon before
configuring this server:

1. Download \`conduit-addon-v${version}.zip\` from
   [Releases](${REPO_URL}/releases) and extract it into your project root, so the
   files land under \`addons/conduit/\`.
2. Open the project once so Godot loads the extension.
3. For game-side tools (play, input, screenshots), add the runtime autoload:
   Project Settings, Globals, Autoload, add
   \`res://addons/conduit/conduit_runtime.tscn\` named \`ConduitRuntime\`.

On macOS, clear quarantine after extracting:
\`xattr -dr com.apple.quarantine addons/conduit\`.

Install the \`v${version}\` addon to match this package. The addon zip and this
package are released together from the same tag, and a mismatched pair is the
first thing to suspect if tools are missing or a call fails to route.

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
        "CONDUIT_ENABLE": "1",
        "CONDUIT_GODOT": "/absolute/path/to/godot"
      }
    }
  }
}
\`\`\`

On Bun, use \`bunx\` as the \`command\` and drop the \`-y\`. To stay on a known pair
rather than tracking the latest, pin the version: \`${PACKAGE_NAME}@${version}\`.

Both environment variables are optional. \`CONDUIT_ENABLE=1\` lets the game-side
bridge activate in games launched from an editor the broker started;
\`CONDUIT_GODOT\` tells the broker which engine binary to use for
\`gd_editor_launch\` and \`gd_project_scaffold\`.

Editor-side tools need no opt-in: the broker finds any running editor for the
configured project automatically.

## Requirements

- Godot 4.4 or newer.
- Node.js 20 or newer (tested on 22), or Bun 1.2 or newer.
- Prebuilt bridge platforms: Windows x64, Linux x64 (glibc 2.35+), macOS
  universal.

For a machine with neither Node nor Bun, a standalone binary of this same server
is published on [Releases](${REPO_URL}/releases); use its absolute path as the
\`command\` instead.

## Flags

| Flag | Env | Effect |
| --- | --- | --- |
| \`--project <path>\` | \`CONDUIT_PROJECT\` | The Godot project to attach to (required, or \`CONDUIT_SOCK\`). |
| \`--godot <path>\` | \`CONDUIT_GODOT\` | Engine binary for \`gd_editor_launch\` and \`gd_project_scaffold\`. |
| \`--enable-pixel-tools\` | \`CONDUIT_ENABLE_PIXEL_TOOLS\` | Enable coordinate-level editor mouse tools (off by default). |
| \`--enable-editor-eval\` | \`CONDUIT_ENABLE_EDITOR_EVAL\` | Enable \`gd_editor_eval\` (off by default). |
| \`--disable-eval\` | \`CONDUIT_DISABLE_EVAL\` | Drop the whole eval class of tools. |

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
    files: ["index.js", "README.md", "LICENSE"],
    engines: { node: ">=20" },
  };
  writeFileSync(join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  copyFileSync(join(repoRoot, "LICENSE"), join(outDir, "LICENSE"));
  writeFileSync(join(outDir, "README.md"), readme(version));

  console.log(`staged ${PACKAGE_NAME} ${version} in ${outDir}`);
  // Tagged releases publish from the release workflow over OIDC. This manual
  // path is for the first publish, before a trusted publisher can be registered.
  console.log(`first publish (token auth): cd ${join("dist", "npm")} && bun publish`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
