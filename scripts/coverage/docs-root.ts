// Where the offline Godot docs live. Audit tooling only: nothing under
// broker/src/ may learn about this, for the same reason the broker may never
// read GODOT_BIN (CLAUDE.md).

import fs from "node:fs";
import path from "node:path";

export function resolveDocsRoot(argv: string[] = Bun.argv): string {
  const flagIndex = argv.indexOf("--docs");
  const fromFlag = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  const root = fromFlag ?? process.env.CONDUIT_GODOT_DOCS;
  if (!root) {
    throw new Error("no docs root: pass --docs <dir> or set CONDUIT_GODOT_DOCS to a godot-docs-html checkout");
  }
  const sources = path.join(root, "_sources");
  if (!fs.existsSync(sources)) {
    throw new Error(`${root} has no _sources directory; point at the root of an HTML docs build`);
  }
  return root;
}

/** The docs build stamps its version into index.html; a coverage claim is meaningless without it. */
export function docsVersion(root: string): string {
  const index = path.join(root, "index.html");
  if (!fs.existsSync(index)) return "unknown";
  const match = /Godot Engine \(([^)]+)\) documentation/.exec(fs.readFileSync(index, "utf8"));
  return match?.[1] ?? "unknown";
}
