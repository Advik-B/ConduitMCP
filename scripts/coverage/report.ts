// Renders docs/coverage-matrix.md and docs/coverage-matrix.json from the audit.
//
// Deterministic by construction: no timestamps, no ordering that depends on
// iteration order of a hash, so re-running with the same docs and the same tool
// surface produces a byte-identical file and a diff means something changed.

import fs from "node:fs";
import path from "node:path";

import { runAudit, staleClaims, summarise, TIER_LABEL, type AuditResult, type MemberVerdict, type SectionVerdict, type Tier } from "./audit.ts";
import { resolveDocsRoot } from "./docs-root.ts";
import { EXCLUDED_AREAS } from "./section-rules.ts";
import { capabilityIds } from "./extract-tools.ts";

const TIERS: Tier[] = ["T0", "T1", "T2", "T3", "T4", "T5"];

function pct(part: number, total: number): string {
  return total === 0 ? "0.0%" : `${((part / total) * 100).toFixed(1)}%`;
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

function tierRow(label: string, items: Array<{ tier?: Tier; best?: Tier }>, pick: (item: never) => Tier): string {
  const counts = countBy(items as never[], pick);
  const total = items.length;
  const cells = TIERS.map((tier) => {
    const n = counts.get(tier) ?? 0;
    return n === 0 ? "-" : `${n} (${pct(n, total)})`;
  });
  return `| ${label} | ${cells.join(" | ")} | ${total} |`;
}

function memberTable(members: MemberVerdict[]): string {
  const head = `| Surface | ${TIERS.map((tier) => `${tier}`).join(" | ")} | total |\n|---|${TIERS.map(() => "---").join("|")}|---|`;
  const rows = [
    tierRow("Best of both bridges", members, (member: MemberVerdict) => member.best),
    tierRow("Runtime bridge", members, (member: MemberVerdict) => member.runtime.tier),
    tierRow("Editor bridge", members, (member: MemberVerdict) => member.editor.tier),
  ];
  return `${head}\n${rows.join("\n")}`;
}

function classKindTable(members: MemberVerdict[]): string {
  const kinds = [...new Set(members.map((member) => member.classKind))].sort();
  const lines = kinds.map((kind) => {
    const subset = members.filter((member) => member.classKind === kind);
    return tierRow(kind, subset, (member: MemberVerdict) => member.best);
  });
  const head = `| Class kind | ${TIERS.join(" | ")} | total |\n|---|${TIERS.map(() => "---").join("|")}|---|`;
  return `${head}\n${lines.join("\n")}`;
}

function areaTable(sections: SectionVerdict[]): string {
  const actions = sections.filter((section) => section.kind === "action");
  const areas = [...new Set(actions.map((section) => section.area))].sort();
  const head = `| Docs area | ${TIERS.join(" | ")} | actions | concepts |\n|---|${TIERS.map(() => "---").join("|")}|---|---|`;
  const rows = areas.map((area) => {
    const subset = actions.filter((section) => section.area === area);
    const concepts = sections.filter((section) => section.area === area && section.kind === "concept").length;
    const counts = countBy(subset, (section) => section.tier);
    const cells = TIERS.map((tier) => {
      const n = counts.get(tier) ?? 0;
      return n === 0 ? "-" : String(n);
    });
    return `| ${area} | ${cells.join(" | ")} | ${subset.length} | ${concepts} |`;
  });
  return `${head}\n${rows.join("\n")}`;
}

/** The distinct reasons a section was graded T2 or worse, largest first. */
function gapClusters(sections: SectionVerdict[]): string {
  const gaps = sections.filter((section) => section.kind === "action" && ["T2", "T3", "T4", "T5"].includes(section.tier));
  const byVia = new Map<string, { tier: Tier; count: number; pages: Set<string> }>();
  for (const section of gaps) {
    const entry = byVia.get(section.via) ?? { tier: section.tier, count: 0, pages: new Set<string>() };
    entry.count += 1;
    entry.pages.add(section.page);
    byVia.set(section.via, entry);
  }
  const rows = [...byVia.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([via, entry]) => `| ${entry.tier} | ${entry.count} | ${entry.pages.size} | ${via} |`);
  return `| Tier | Headings | Pages | Why nothing semantic reaches it |\n|---|---|---|---|\n${rows.join("\n")}`;
}

function topGapClasses(members: MemberVerdict[]): string {
  const gaps = members.filter((member) => member.best !== "T0" && member.best !== "T1" && !member.deprecated);
  // Keyed by an object rather than a joined string: a delimiter that cannot
  // appear in a class name is either fragile or unprintable, and an earlier
  // version reached for a NUL, which made this source file read as binary.
  const byClass = new Map<string, { kind: string; count: number }>();
  for (const member of gaps) {
    const entry = byClass.get(member.class) ?? { kind: member.classKind, count: 0 };
    entry.count += 1;
    byClass.set(member.class, entry);
  }
  const rows = [...byClass.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 30)
    .map(([name, entry]) => `| \`${name}\` | ${entry.kind} | ${entry.count} |`);
  const header = "| Class | Kind | Members with no semantic path |\n|---|---|---|\n";
  return header + rows.join("\n");
}

export function render(result: AuditResult): string {
  const summary = summarise(result);
  const members = result.members;
  const sections = result.sections;
  const actions = sections.filter((section) => section.kind === "action");
  const gated = result.tools.maximal
    .filter((tool) => !result.tools.defaultNames.includes(tool.name))
    .map((tool) => `\`${tool.name}\``)
    .sort();

  const t2plus = members.filter((member) => !["T0", "T1"].includes(member.best));
  const actionGaps = actions.filter((section) => !["T0", "T1"].includes(section.tier));
  const objectGap = members.filter((member) => member.classKind === "object" && member.best === "T2").length;
  const objectClasses = summary.classes.byKind.object ?? 0;

  return `# Coverage matrix: Godot ${summary.docsVersion} documentation vs. the Conduit MCP surface

Generated by \`bun run coverage\` from \`scripts/coverage/\`. Do not edit by hand;
edit the extractors, \`coverage-map.ts\`, or \`section-rules.ts\` and regenerate.

Measured against the Godot **${summary.docsVersion}** documentation, which matches the engine this
repository targets (gdext 0.5.5 / Godot 4.7.1, \`docs/api-gaps.md\`). A coverage
claim against a different engine version would not mean anything, so the version
is part of the result.

## What this measures

Whitepaper section 4.1 sets the bar: *"For every action a developer takes in the
editor or the running game, there should be a tool that performs the equivalent
action through the engine's own API."* This document measures the shipped tool
surface against that sentence, using the engine's own documentation as the list
of actions.

A yes/no reading would be useless, because \`gd_game_eval\` runs arbitrary GDScript
and therefore reaches everything. Reachability is graded instead:

| Tier | Meaning | Counts as a gap? |
|---|---|---|
| **T0** | A dedicated tool performs the action | no |
| **T1** | A generic reflection tool reaches it (\`gd_node_call\`, \`gd_node_set_property\`, \`gd_scene_node_set_property\`, \`gd_resource_set_property\`, \`gd_signal\`) | no |
| **T2** | Only evaluation reaches it (\`gd_game_eval\`, \`gd_editor_eval\`) | **yes** |
| **T3** | Only tier-2 editor control-tree driving reaches it (\`gd_editor_ui\`) | **yes** |
| **T4** | Only pixels reach it (\`gd_editor_pixel_*\`) | **yes** |
| **T5** | Nothing reaches it | **yes, worst** |

**T2 and worse are gaps even though they are possible.** That is the judgment
this whole document rests on, so it is stated plainly rather than buried: section
4.1 asks for an equivalent action *through the engine's API*, not for arbitrary
code that happens to produce the effect. An agent that must write GDScript to set
an import option is not using a tool, it is bypassing the absence of one.

Two further points sharpen T2. First, \`gd_editor_eval\` is **off by default** and
must be enabled with \`--enable-editor-eval\`, so an edit-time T2 is unreachable in
a default deployment, not merely inelegant. Second, \`--disable-eval\` drops both
evals, and a deployment that takes that option loses every T2 capability outright.

## The surface being measured

| | count |
|---|---|
| Tools registered, all flags on | ${summary.tools.maximal} |
| Tools registered, default flags | ${summary.tools.default} |
| Distinct capabilities, counting \`(tool, op)\` pairs | ${summary.tools.capabilities} |
| Off unless explicitly enabled | ${gated.join(", ")} |

\`gd_debug\` alone carries nine ops, so tool count understates the surface; the
capability count is the honest denominator, and it is what section 7.1's
consolidation discipline is spending its budget on.

## Exclusions, stated rather than applied silently

Excluded from the class reference:

- **Variant built-in types** (${summary.classes.byKind.builtin ?? 0} pages with no \`Inherits:\` line: \`Vector2\`,
  \`Transform3D\`, \`Color\`, \`AABB\`, and friends). These are values, not engine
  actions. Their wire coverage is a separate, already-recorded concern
  (\`docs/api-gaps.md\`, tagged Variant conversion).
- **\`@GlobalScope\` and \`@GDScript\`** (${summary.classes.byKind.global ?? 0} pages): language surface, not engine objects.
- **Constants, enums, operators, constructors, theme items, and virtual
  (\`_\`-prefixed) methods.** Constants are values; virtuals are for the project to
  override, not for an agent to call.

Excluded from the tutorial sweep, by area and reason:

${Object.entries(EXCLUDED_AREAS)
  .sort()
  .map(([area, reason]) => `- \`${area}\` -- ${reason}`)
  .join("\n")}

Within the areas that remain, a heading is classified as an **action** or a
**concept**. "Adding a camera" is an action; "Why use HTTP?" is prose that
explains rather than instructs, and grading it would inflate both numerator and
denominator. ${summary.sections.concepts} of ${summary.sections.inScope} in-scope headings are concepts.

## Result: the class reference

${summary.classes.total} class pages yield ${members.length} actionable members
(${summary.members.byKind.method ?? 0} methods, ${summary.members.byKind.property ?? 0} properties, ${summary.members.byKind.signal ?? 0} signals) after exclusions.

${memberTable(members)}

**${pct(t2plus.length, members.length)} of the documented engine API has no semantic path.** The
editor bridge is now the better of the two (${pct(members.filter((m) => m.editor.tier === "T2").length, members.length)} at T2 versus ${pct(members.filter((m) => m.runtime.tier === "T2").length, members.length)}),
having been the worse before the target grammar and \`gd_scene_node_call\`
landed: the resource verbs are edit-time only, so a resource is reachable there
and not in a running game. See the findings below.

By class kind:

${classKindTable(members)}

The \`node\` row is the shape the design intends: a node is addressable, so its
members are reachable generically. Every other row is a class of object the tool
surface cannot name.

## Result: the tutorials

${new Set(sections.map((section) => section.page)).size} pages across ${new Set(sections.map((section) => section.area)).size} areas, swept exhaustively at heading level:
${summary.sections.total} headings, ${summary.sections.excluded} in excluded areas, ${summary.sections.concepts} conceptual, leaving
**${actions.length} discrete actions**, of which **${actionGaps.length} (${pct(actionGaps.length, actions.length)}) are T2 or worse**.

${areaTable(sections)}

## Why the remaining gaps exist

Four missing *generic verbs* used to account for the whole class-reference gap.
Three are now closed, and what is left has a different shape because of it.

### Closed: singleton targeting

Every generic tool now takes an optional \`target\` accepting \`singleton:<Class>\`
alongside a node path, parsed in one place (\`bridge/src/handlers/target.rs\`) and
resolved through \`Engine::get_singleton\`. \`gd_node_call\`,
\`gd_node_get_property\`, \`gd_node_set_property\`, \`gd_node_get_info\`,
\`gd_scene_node_call\`, \`gd_scene_node_get_property\`, and
\`gd_scene_node_set_property\` all share it. \`node_path\` still works unchanged, so
the grammar is additive and no existing call had to move. All singleton classes
are now T1.

A singleton property write is applied directly and reports \`undoable: false\`:
engine-global state does not belong on the edited scene's undo history, where
\`gd_undo\` would otherwise claim to revert something the history never owned.

### Closed: the edit-time method call

\`gd_scene_node_call\` gives edit time the counterpart of \`gd_node_call\`, so
\`TileMapLayer.set_cell\` and \`NavigationRegion3D.bake_navigation_mesh\` are
drivable on the edited scene without \`gd_editor_eval\`.

It is deliberately **not** undo-wrapped: an arbitrary method call has no
inverse, so an \`add_do_method\` entry with no meaningful undo half would let
\`gd_undo\` report success while restoring nothing. The response carries
\`undoable: false\` and the caller saves the scene itself. This follows the
argument \`bridge/src/handlers/editor/resource.rs\` already makes for resources --
a misreporting undo is worse than no undo.

### Closed: resource read and call

\`gd_resource_get_property\` (with an \`op: list\` that enumerates property names)
and \`gd_resource_call\` complete a surface that could previously only be written.

**Edit time only.** Both load and save through a \`res://\` path, so they belong to
the editor bridge; a resource held by a node in a *running* game still has no
handle. That is why the class-kind table below shows resources near-fully T1
while the runtime row stays far worse than the editor row -- the headline tier is
the better of the two bridges, and for resources only one bridge reaches them.

### Open: non-node engine objects have no handle

What remains is one shape of problem: ${objectGap} members across ${objectClasses}
\`Object\`-derived classes that are neither nodes, singletons, nor resources -- \`PhysicsDirectSpaceState3D\`,
\`SurfaceTool\`, \`MeshDataTool\`, \`EditorSelection\`, \`RegEx\`, \`Semaphore\`. Some are
handed out by other calls, some are constructed. Nothing in the surface can hold
one across two tool calls, which is why \`gd_physics\` had to wrap space-state
queries as dedicated ops rather than exposing the object.

Closing it needs something the other three did not: a handle table with a
lifetime, because these objects have no stable name the way a node path or a
class name does. That is a materially larger design question than the three
resolvers above, which is why the roadmap ranks it below the authoring surfaces
rather than above them.

## Capabilities the whitepaper specifies that are not implemented

Section 8 of the whitepaper is the parity target. These items appear there and do
not appear in the shipped surface. They are listed separately from the docs diff
because they are not judgment calls: the design says they exist and they do not.

| Section 8 text | Status |
|---|---|
| "enable or disable editor plugins" | **Absent.** No tool; \`gd_project_set_setting\` can write \`editor_plugins/enabled\` blind. |
| "create and read shaders and themes" | **Absent.** \`gd_resource_create\` can make the resource; nothing compiles a shader or returns diagnostics, and no theme tool exists. |
| "Shader creation gets the same log-derived compile diagnostics" | **Absent.** \`gd_script_validate\` is script-only. |
| "and manage translations" | **Absent.** No translation tool; the CSV/PO pipeline is editor-menu driven. |
| "process-mode control" (section 8, observation and debugging) | **Absent** as a dedicated tool; reachable as a node property. |

"Read and set import settings" left this table in phase 13. \`gd_import_settings\`
ships it, though not literally "through the import plugin surface": it reads and
writes the \`.import\` sidecar through \`ConfigFile\`, because a \`ResourceImporter\`
is one of the objects nothing can name (\`docs/api-gaps.md\`). The difference is
visible only in that an importer cannot be asked for options an asset does not
already carry.

## Ranked gap clusters, tutorials

Every heading graded T2 or worse, grouped by the reason nothing semantic reaches
it, largest first.

${gapClusters(sections)}

## Classes with the most unreachable members

Deprecated members excluded, so this ranks work worth doing rather than work the
engine is retiring. (${members.filter((m) => m.deprecated && !["T0", "T1"].includes(m.best)).length} gap members are deprecated and are excluded here.)

${topGapClasses(members)}

## Roadmap

### Done

**Phase 10: singleton targeting.** The \`target\` grammar, shared by every generic
tool on both bridges. *Accepted* by \`bun run phase10\`, which drives
\`OS.get_name()\`, \`ProjectSettings.get_setting\`, and an \`Engine\` property
round-trip with \`--disable-eval\` set, so nothing it proves can be eval in
disguise.

**Phase 11: edit-time method call.** \`gd_scene_node_call\`. *Accepted* by the same
runner: \`TileMapLayer.set_cell\` and \`get_cell_source_id\` on the edited scene with
no eval tool registered. Not undo-wrapped, for the reason given above; the
acceptance asserts \`undoable: false\` rather than asserting an undo that would be
a lie.

**Phase 12: resource read and call.** \`gd_resource_get_property\` and
\`gd_resource_call\`. *Accepted* by the same runner: a \`Curve\` property list, an
\`add_point\` that persists, and a property read with no preceding write.

**Phase 13: import settings.** \`gd_import_settings\`, reading and writing the
\`[params]\` of an asset's \`.import\` sidecar through \`ConfigFile\` and
reimporting afterwards. *Accepted* by \`bun run phase13\`, also with
\`--disable-eval\`: it ingests a texture, flips \`compress/mode\`, and asserts the
artifact under \`.godot/imported/\` changed. Not undo-wrapped -- an \`.import\`
write is a file write, not edited-scene state -- so the response reports
\`undoable: false\`. An option the asset does not already carry is an error
rather than a silent insert, which is sound because the importer writes its full
default set on first import; the runner asserts that property rather than
assuming it (\`docs/api-gaps.md\`).

### Next

**Phase 14: authoring surfaces.** TileSet sources and terrains, theme resources,
animation track types beyond value tracks, shader create-and-validate, and
lightmap/occlusion baking. Larger and more separable than the phases above; each
is its own tool with its own acceptance criterion.

**Phase 15: editor plugin and translation management.** The two remaining
section 8 items, both small.

**Phase 16: object handles.** The last generic verb, and the only remaining
class-reference cluster. Deliberately last: unlike the three resolvers, it needs
a handle table with a lifetime, and its cost is design rather than plumbing.

XR is deliberately absent from this list. It needs hardware and a runtime the
bridge cannot simulate, and the honest answer is to say so rather than to ship a
tool that cannot work.
`;
}

if (import.meta.main) {
  const root = resolveDocsRoot();
  const result = runAudit(root);
  // A coverage map that names members the reference does not have would
  // understate T0 without failing anything, so this is fatal rather than a note.
  const stale = staleClaims(result.classes);
  if (stale.length > 0) {
    console.error(`coverage-map.ts makes ${stale.length} claim(s) the documentation does not back:`);
    for (const problem of stale) console.error(`  ${problem}`);
    process.exit(1);
  }
  const docs = path.join(import.meta.dir, "..", "..", "docs");
  const markdown = path.join(docs, "coverage-matrix.md");
  const json = path.join(docs, "coverage-matrix.json");
  fs.writeFileSync(markdown, render(result));
  fs.writeFileSync(
    json,
    `${JSON.stringify(
      {
        summary: summarise(result),
        // Carried in the sidecar so a consumer does not have to hardcode the scale.
        tiers: TIER_LABEL,
        capabilities: capabilityIds(result.tools.maximal),
        members: result.members,
        sections: result.sections,
      },
      null,
      2,
    )}\n`,
  );
  const summary = summarise(result);
  console.log(`wrote ${markdown} and ${json}`);
  console.log(
    `docs ${summary.docsVersion}: ${summary.members.total} members, ${summary.sections.actions} tutorial actions, ${summary.sections.unclassified} unclassified`,
  );
}
