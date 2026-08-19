// Structured inventory of the Godot class reference, parsed from the Sphinx
// _sources/*.rst.txt that ship alongside the HTML. The RST is generated from
// the engine's own XML, so its anchors are stable and machine-readable in a way
// the rendered HTML is not.

import fs from "node:fs";
import path from "node:path";

import { docsVersion, resolveDocsRoot } from "./docs-root.ts";

export type MemberKind = "method" | "property" | "signal";

export interface MemberRecord {
  kind: MemberKind;
  name: string;
  deprecated: boolean;
  experimental: boolean;
}

/** How a class can be reached at all, which is what decides its members' tier. */
export type ClassKind = "node" | "resource" | "singleton" | "object" | "builtin" | "global";

export interface ClassRecord {
  name: string;
  kind: ClassKind;
  inherits: string[];
  deprecated: boolean;
  experimental: boolean;
  members: MemberRecord[];
}

const CLASS_ANCHOR = /^\.\. _class_([A-Za-z0-9_@]+):$/;

/**
 * Member anchors must be keyed off the already-known class name, not matched
 * generically. A generic pattern is ambiguous: `_class_Object_method_get_property_list`
 * also parses as class `Object_method_get` + property `list`, and a greedy class
 * group picks exactly that wrong split, silently inflating the property count.
 */
function memberAnchor(className: string): RegExp {
  // Class names come from the anchor grammar ([A-Za-z0-9_@]+), so none of them
  // carry a regex metacharacter and no escaping is needed.
  return new RegExp("^\.\. _class_" + className + "_(method|property|signal)_(.+):$");
}
const INHERITS = /^\*\*Inherits:\*\*\s*(.*)$/;
const CLASS_REF = /:ref:`[^<`]*<class_([A-Za-z0-9_@]+)>`/g;

/**
 * @GlobalScope's property table is the engine's own list of singletons: every
 * globally-reachable singleton is exposed there as a property whose type is the
 * singleton's class. Cheaper and more honest than a hand-maintained list.
 */
export function readSingletons(root: string): Set<string> {
  const file = path.join(root, "_sources", "classes", "class_@globalscope.rst.txt");
  const text = fs.readFileSync(file, "utf8");
  const names = new Set<string>();
  for (const match of text.matchAll(/class_@GlobalScope_property_([A-Za-z0-9_]+)/g)) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

function classifyKind(name: string, inherits: string[], singletons: Set<string>): ClassKind {
  if (name.startsWith("@")) return "global";
  if (singletons.has(name)) return "singleton";
  // A page with no Inherits line is either Object itself or a Variant built-in
  // (Vector2, Transform3D, Color). Built-ins are values, not engine actions.
  if (inherits.length === 0) return name === "Object" ? "object" : "builtin";
  if (name === "Node" || inherits.includes("Node")) return "node";
  if (name === "Resource" || inherits.includes("Resource")) return "resource";
  return "object";
}

function parseClass(file: string, singletons: Set<string>): ClassRecord | null {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let name: string | null = null;
  let inherits: string[] = [];
  let deprecated = false;
  let experimental = false;
  const members: MemberRecord[] = [];
  let sawFirstMember = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (!name) {
      const anchor = CLASS_ANCHOR.exec(line);
      if (anchor?.[1]) {
        name = anchor[1];
        continue;
      }
    }

    const inheritLine = INHERITS.exec(line);
    if (inheritLine?.[1] && inherits.length === 0) {
      inherits = [...inheritLine[1].matchAll(CLASS_REF)].map((match) => match[1] as string);
      continue;
    }

    const member = name ? memberAnchor(name).exec(line) : null;
    if (member?.[1] && member[2]) {
      // Anchors also appear inside cross-reference tables at the top of the
      // page; only the ones under the detail sections are followed by an
      // rst-class signature block, which is what distinguishes them.
      const window = lines.slice(index + 1, index + 4).join("\n");
      if (!window.includes("rst-class:: classref-")) continue;
      const body = lines.slice(index + 1, index + 8).join("\n");
      sawFirstMember = true;
      members.push({
        kind: member[1] as MemberKind,
        name: member[2],
        deprecated: body.includes("**Deprecated:**"),
        experimental: body.includes("**Experimental:**"),
      });
      continue;
    }

    // Class-level deprecation sits in the header, before any member block.
    if (!sawFirstMember) {
      if (line.startsWith("**Deprecated:**")) deprecated = true;
      if (line.startsWith("**Experimental:**")) experimental = true;
    }
  }

  if (!name) return null;
  return { name, kind: classifyKind(name, inherits, singletons), inherits, deprecated, experimental, members };
}

export function extractClasses(root: string): ClassRecord[] {
  const dir = path.join(root, "_sources", "classes");
  const singletons = readSingletons(root);
  const records: ClassRecord[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".rst.txt")) continue;
    const record = parseClass(path.join(dir, entry), singletons);
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.name.localeCompare(b.name));
}

if (import.meta.main) {
  const root = resolveDocsRoot();
  const classes = extractClasses(root);
  const byKind: Record<string, number> = {};
  let members = 0;
  const memberByKind: Record<string, number> = {};
  for (const record of classes) {
    byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
    members += record.members.length;
    for (const member of record.members) {
      memberByKind[member.kind] = (memberByKind[member.kind] ?? 0) + 1;
    }
  }
  console.log(JSON.stringify({ docsVersion: docsVersion(root), classes: classes.length, byKind, members, memberByKind }, null, 2));
}
