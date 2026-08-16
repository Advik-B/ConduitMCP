// The shipped agent skill (skills/godot-conduit) names tools in prose, so it can
// drift from the registry silently. Two checks, in opposite directions: no tool
// name in the skill may be one that does not exist, because a phantom name sends
// an agent chasing nothing; and every registered tool must appear in the
// reference map, which is exhaustive by contract. SKILL.md itself is deliberately
// selective, so only the map carries the coverage obligation.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { BridgeManager } from "../src/bridge-manager.ts";
import type { EventRing } from "../src/events.ts";
import { GodotResolver } from "../src/godot-locate.ts";
import { registerTools } from "../src/index.ts";
import { DEFAULT_TIMEOUTS } from "../src/tool-helpers.ts";
import { TOOL_GROUP_BY_NAME } from "../src/tool-registry.ts";

const skillDir = join(import.meta.dir, "..", "..", "skills", "godot-conduit");
const SKILL_FILES = ["SKILL.md", join("references", "tool-map.md"), join("references", "recipes.md")];

// Names the skill mentions that are not MCP tools: two bridge-protocol commands
// behind the dynamic surface, and the placeholder the prose uses for a tool whose
// name comes from project code at runtime.
const NOT_MCP_TOOLS = new Set(["gd_project_tools_list", "gd_project_call", "gd_project_method"]);

function registeredToolNames(): Set<string> {
  const names: string[] = [];
  const server = {
    registerTool(name: string) {
      names.push(name);
    },
  } as unknown as McpServer;
  // Flag-gated tools are documented in the map, so register the full surface.
  registerTools(server, {} as unknown as BridgeManager, {} as unknown as EventRing, {
    enablePixelTools: true,
    enableEditorEval: true,
    disableEval: false,
    godot: new GodotResolver(null),
    projectPath: null,
    runtimeDir: "",
    addonSource: null,
    timeouts: DEFAULT_TIMEOUTS,
  });
  return new Set(names);
}

/**
 * Tool names mentioned in a skill file.
 *
 * Two exclusions keep prose from being read as a claim about a tool: a match
 * ending in `_` is a family reference (`gd_node_`, `gd_project_`), and a match
 * followed by `*` is a glob over one (`gd_editor_pixel_*`).
 */
function mentionedToolNames(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/gd_[a-z0-9_]+/g)) {
    const name = match[0];
    if (name.endsWith("_") || text[(match.index ?? 0) + name.length] === "*") {
      continue;
    }
    found.add(name);
  }
  return found;
}

function readSkillFile(relative: string): string {
  return readFileSync(join(skillDir, relative), "utf8");
}

/**
 * The YAML frontmatter block of a skill file, or "" when there is none.
 *
 * Tolerant of both line endings on purpose. The repository has no
 * .gitattributes, so a checkout with core.autocrlf=true delivers CRLF and a
 * pattern anchored on \n alone silently matches nothing. That is not
 * hypothetical: it passed here and failed the Windows CI leg.
 */
export function frontmatterOf(text: string): string {
  return text.match(/^---\r?\n(.*?)\r?\n---/s)?.[1] ?? "";
}

describe("the shipped agent skill", () => {
  const registered = registeredToolNames();

  test.each(SKILL_FILES)("%s names only tools that exist", (relative) => {
    const phantom = [...mentionedToolNames(readSkillFile(relative))]
      .filter((name) => !registered.has(name) && !NOT_MCP_TOOLS.has(name))
      .sort();
    expect(phantom).toEqual([]);
  });

  test("the reference map covers every registered tool", () => {
    const documented = mentionedToolNames(readSkillFile(join("references", "tool-map.md")));
    const missing = Object.keys(TOOL_GROUP_BY_NAME)
      .filter((name) => !documented.has(name))
      .sort();
    expect(missing).toEqual([]);
  });

  test("the frontmatter carries a name and a description", () => {
    const frontmatter = frontmatterOf(readSkillFile("SKILL.md"));
    expect(frontmatter).toContain("name: godot-conduit");
    expect(frontmatter).toContain("description:");
  });

  // Asserted against both forms rather than against whatever this checkout
  // happens to hold, so the result does not depend on the developer's
  // core.autocrlf. Reading the file and trusting a local pass is exactly what
  // let the CRLF bug through.
  test("the frontmatter parses under either line ending", () => {
    const lf = readSkillFile("SKILL.md").replace(/\r\n/g, "\n");
    expect(frontmatterOf(lf)).toContain("name: godot-conduit");
    expect(frontmatterOf(lf.replace(/\n/g, "\r\n"))).toContain("name: godot-conduit");
  });
});
