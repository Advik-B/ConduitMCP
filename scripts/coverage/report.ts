// Renders docs/coverage-matrix.md and docs/coverage-matrix.json from the audit.
//
// Deterministic by construction: no timestamps, no ordering that depends on
// iteration order of a hash, so re-running with the same docs and the same tool
// surface produces a byte-identical file and a diff means something changed.

import fs from "node:fs";
import path from "node:path";

import { runAudit, staleClaims, staleSectionRules, summarise, TIER_LABEL, type AuditResult, type MemberVerdict, type SectionVerdict, type Tier } from "./audit.ts";
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
  // The best-of-both row reaching zero is the intended end state, and an empty
  // table with a header reads as a rendering failure rather than as a result.
  if (rows.length === 0) {
    return "No class has a member the best of the two bridges cannot reach semantically, so this ranking is empty.";
  }
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
| **T1** | A generic reflection tool reaches it (\`gd_node_call\`, \`gd_node_set_property\`, \`gd_scene_node_set_property\`, \`gd_resource_set_property\`, \`gd_signal\`, \`gd_scene_signal\`) | no |
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

Five missing *generic verbs* accounted for the whole class-reference gap. All
five are now closed, and what remains is a stated grading rather than a missing
verb.

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

### Closed: non-node engine objects have handles

The fourth verb, and the one that needed a different mechanism. 3732 members
across 295 \`Object\`-derived classes that are neither nodes, singletons, nor
resources -- \`PhysicsDirectSpaceState3D\`, \`SurfaceTool\`, \`MeshDataTool\`,
\`EditorSelection\`, \`RegEx\`, \`Semaphore\` -- had no stable name the way a node
path or a class name does, so nothing in the surface could hold one across two
tool calls. That is why \`gd_physics\` wraps space-state queries as dedicated ops
rather than exposing the object.

A handle is that name. \`bridge/src/handles.rs\` holds a live object per bridge
process and \`object:<n>\` joins \`singleton:<Class>\` in the target grammar, so the
same seven generic tools reach it. Two ways to get one: \`gd_object\` /
\`gd_scene_object\` \`create\` builds a \`RefCounted\` class by name, and
\`capture: true\` on the call and property-read verbs takes one on the value that
came back. Two ways to spend one: as \`target\`, or as
\`{"__type":"Object","handle":"object:<n>"}\` in an argument or a property value,
which is what makes \`PhysicsDirectSpaceState3D.intersect_ray(params)\` reachable
without eval.

Three limits are worth naming here rather than only in \`docs/api-gaps.md\`.
\`create\` refuses non-\`RefCounted\` classes, so those are captured rather than
constructed. Capture is top-level only: an object nested in a returned array or
dictionary still stringifies. And a handle dies with its process, which is what
makes the table per bridge and the tool two tools.

After the regrade, the object-kind row held only its 83 signals at T2, and
phase 17 closed those too (below).

**Resources at runtime are still graded T2**, signals included, and the grading
is deliberate.
A handle reaches a runtime resource when some call hands one out -- \`World3D\`
through \`get_world_3d\` is the motivating case, and the phase 16 runner proves
it -- but that is conditional on such a call existing, and grading 3475 members
T1 on a conditional would move the runtime row by thousands on a claim the
acceptance does not make.

### Closed: a signal on anything the grammar names

The fifth verb, and the last one. \`gd_signal\` and \`gd_scene_signal\` were the
only generic tools that never learned the \`target\` grammar: both resolved
\`node_path\` through a scene tree, so a signal on a singleton, on a handle-held
object, or on a resource was reachable only by writing GDScript. That is 140
members -- 83 on object-kind classes, 31 on singletons, 26 on resources -- and
after phase 16 it was the entire non-node T2 remainder of the class reference.

Both tools now take \`target\` for the emitter and \`receiver\` for the connection
destination, in the same grammar, with \`node_path\` and \`target_path\` kept as
the node-path aliases. \`gd_scene_signal\` also gained the two ops it lacked,
\`emit\` and \`await\`, so both bridges answer the same op set; a \`list\`-only
surface would have been a weak claim to have reached a signal at all.

\`await\` needed a new mechanism rather than a new argument. It used to generate
\`return await Signal(get_node(path), signal)\` and hand it to the evaluation
runner, which limited it to node paths by construction and ran the eval
machinery even under \`--disable-eval\`. It is now a native connection whose
\`PendingOp\` settles when the signal fires, and it reports every argument the
signal carried rather than only the first.

Two limits are worth stating here. A persisted connection still needs both ends
inside the edited scene, because it serializes both: a singleton at either end
connects live and reports \`persisted: false, undoable: false\`, for the reason
\`gd_scene_node_call\` gives.
And runtime resource signals stay T2 with the rest of the runtime resource row,
for the reason given above -- the editor row is what carries them.

### Closed: a static method, and a correction to the grading above

The five verbs all act on an instance, and the tables above assume every member
is reached that way: an \`object\`-kind class grades T1 \`via gd_node_call
(target: object:...)\`, whatever the member is. For a static method that was not
achievable. \`FileAccess.open\` is the case that shows it -- the handle the via
names could only be obtained by calling \`open\`, which is the method being
graded. The tier was right and the reason was circular.

\`class:<Class>\` is the fourth target scheme and it makes the grading true.
\`ClassDb::class_call_static\` is the door, the two call tools branch on it before
resolving anything, and \`capture\` on the result is what turns a static factory
into an \`object:<n>\` the next call can name. No number in the class-reference
tables moves, because none was ever wrong; what moves is that the via now
describes something a caller can actually do.

One inaccuracy is left rather than hidden: the per-member via strings still say
\`target: object:...\` for static methods, because the documentation extractor
carries no staticness flag and adding one is a change to
\`extract-docs.ts\` rather than to a rule. \`gd_classdb methods\` reports
\`static\` per method from the live ClassDB, which is where a caller should look.

### Closed: an RID crosses the wire

Not a target scheme -- an RID names nothing the grammar could resolve -- but the
same class of gap: a value the wire could not carry. \`variant_json.rs\` had no
RID case, so a server handed one back as the display string \`RID(...)\` and no
later call could spend it. It is now tagged in both directions, with the id as a
decimal string because an RID is 64-bit and \`JSON.parse\` rounds above 2^53.

This is what the physics and rendering servers were missing. \`gd_physics\`
wraps the world gravity read as a dedicated op precisely because the space RID
could not be named; the phase 19 acceptance now reaches the same number
generically and asserts the two agree.

## Capabilities the whitepaper specifies that are not implemented

Section 8 of the whitepaper is the parity target. These items appear there and do
not appear in the shipped surface. They are listed separately from the docs diff
because they are not judgment calls: the design says they exist and they do not.

| Section 8 text | Status |
|---|---|
| "process-mode control" (section 8, observation and debugging) | **Absent** as a dedicated tool; reachable as a node property. |

"Enable or disable editor plugins" and "manage translations" left this table in
phase 15, and with them the last two items section 8 named that no tool
reached. \`gd_editor_plugin\` lists every \`res://addons\` directory holding a
\`plugin.cfg\` and toggles one through \`EditorInterface.set_plugin_enabled\`,
naming it by directory the way the engine does. \`gd_translations\` reads and
writes the four \`internationalization/locale/*\` settings the Localization tab
edits: the registered \`.translation\` list, the per-resource remap table, and
the fallback and test locale. Neither is undo-wrapped, for the reason
\`gd_autoload\` gives -- \`ProjectSettings::save()\` persists \`project.godot\`
synchronously, so the edited scene's history never owned the change.

Extracting strings into a POT template did not ship with it and is not an
oversight. That is \`EditorNode\`'s own \`POTGenerator\`, driven from the
Localization dialog, with no scripted entry point; a tool that managed the
source list for a button nothing can press would look like a capability and not
be one. It is graded accordingly rather than counted.

"Create and read shaders and themes" and "shader creation gets the same
log-derived compile diagnostics" left this table in phase 14, the first through
tools that already existed and the second through a new one. A shader's source
is a resource property, so \`gd_resource_create\` plus
\`gd_resource_set_property\` write it and \`gd_resource_get_property\` reads it
back; \`gd_shader_validate\` then compiles it in a headless subprocess and
returns line-numbered diagnostics. A \`Theme\` is reachable the same way, through
\`gd_resource_call\` on \`set_color\`, \`set_stylebox\`, and
\`set_type_variation\`. Neither is a dedicated theme tool, and the tutorial
tiering says so: those headings are T1, not T0.

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
engine is retiring.${t2plus.length === 0 ? "" : ` (${members.filter((m) => m.deprecated && !["T0", "T1"].includes(m.best)).length} gap members are deprecated and are excluded here.)`}

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

**Phase 14: shader diagnostics, and a corrected audit.** Predicted as five
authoring tools -- TileSet sources and terrains, theme resources, animation
track types, shader create-and-validate, and lightmap/occlusion baking -- it
shipped as one tool plus a correction, because four of those five were already
reachable and this document had stopped saying so.

\`gd_shader_validate\` is the tool: it compiles a \`.gdshader\` in a short-lived
headless subprocess and returns line-numbered diagnostics, the way
\`gd_script_validate\` does for scripts. *Accepted* by \`bun run phase14\` with
\`--disable-eval\`: a shader with a deliberate error on line 4 comes back
\`valid: false\` naming line 4, and comes back \`valid: true\` once fixed. The
headless part was the open question and the answer was measured rather than
assumed -- Godot's dummy renderer does compile shaders and does report errors,
so no display is needed and the runner belongs in \`ci:phases\`
(\`docs/api-gaps.md\`).

The correction is the larger half. \`Theme.set_color\`, \`TileSet.add_source\`,
\`TileSetAtlasSource.create_tile\`, \`Animation.add_track\`, and \`VoxelGI.bake\`
are all in the 4.7 reference and all reachable through \`gd_resource_call\` and
\`gd_node_call\`, which phases 11 and 12 shipped; the tutorial rules had not been
revisited since before those phases and still called them unreachable. Baking
lightmaps and occluders is the one genuine absence in that list, and it is not a
missing tool: \`LightmapGI\` has no methods at all and \`OccluderInstance3D\` has
only its bake mask accessors, so those are editor buttons and are now graded T3
rather than T2. The shader cluster was a page-wide catch-all that graded 101
headings as unreachable actions, 42 of them prose about formatting and about
porting GLSL. Correcting the rules took tutorial actions graded T2 or worse from
504 to 314 without a single tool being added for them.

**Phase 15: editor plugin and translation management.** The two remaining
section 8 items, and with them the last of that parity target.
\`gd_editor_plugin\` lists, enables, and disables addons under
\`res://addons\`; \`gd_translations\` registers translations, remaps resources
per locale, and sets the fallback and test locale. *Accepted* by
\`bun run phase15\`, also with \`--disable-eval\`: a generated fixture plugin is
enabled and disabled with its own \`_enter_tree\` and \`_exit_tree\` marker
proving it actually loaded rather than merely being flagged, and a CSV imported
to \`.translation\` resources is registered, remapped, and removed, each state
read back out of \`project.godot\`.

Two things were measured rather than assumed. A headless editor does run an
enabled plugin's \`_enter_tree\`, so the runner needs no display and belongs in
\`ci:phases\`; and \`EditorInterface.set_plugin_enabled\` reports nothing, so
the handler reads the flag back to tell a refusal from a success. POT
extraction stayed out for the reason given above (\`docs/api-gaps.md\`).

**Phase 16: object handles.** The fourth generic verb, and the largest single
cluster left: 3732 members across 295 \`Object\`-derived classes that no node
path, class name, or \`res://\` path could name. \`bridge/src/handles.rs\` holds a
live object per bridge process, \`object:<n>\` joins the target grammar, and
\`gd_object\` / \`gd_scene_object\` create, list, and release. A handle is spent as
a \`target\` or as \`{"__type":"Object","handle":"object:<n>"}\` in an argument, so
\`PhysicsDirectSpaceState3D.intersect_ray(params)\` -- the query \`gd_physics\` had
to wrap as a dedicated op -- is now drivable generically. *Accepted* by
\`bun run phase16\`, the editor half with \`--disable-eval\`: a \`ConfigFile\` built
from nothing carries its state across three separate calls and lands on disk, a
\`TileSetAtlasSource\` goes into \`TileSet.add_source\` as an argument and comes
back out through \`capture\`, a constructed ray query runs against a captured
space state in a headless game, and a handle to a node something else freed
answers \`object_not_found\` instead of crashing the bridge.

Four things were measured rather than assumed. A dead handle is a lookup
through \`try_from_instance_id\` and never a dereference, so freeing an object
under a handle is a clean error. The engine answers \`get_class()\` with its
implementation type (\`GodotPhysicsDirectSpaceState3D\`), not the documented
abstract one. Editor selection does survive a headless editor, so the runner
needs no display. And the runner found a bug older than the phase: a typed
array returned by a dynamic call was reported as \`[]\`, because gdext refuses to
convert one into the untyped \`Array<Variant>\` and \`variant_to_json\` swallowed
the refusal (\`docs/api-gaps.md\`).

**Phase 17: signals on any target.** The last generic verb, and the smallest
cluster: 140 signals on singleton-, object-, and resource-kind classes, which
after phase 16 was every class-reference member the best-of-both row still
graded T2. \`gd_signal\` and
\`gd_scene_signal\` take \`target\` for the emitter and \`receiver\` for the
connection destination; \`gd_scene_signal\` gains \`emit\` and \`await\` so both
bridges answer the same op set; and \`await\` stops delegating to the evaluation
runner, connecting a native callable and settling a \`PendingOp\` instead.
*Accepted* by \`bun run phase17\`, the editor half with \`--disable-eval\`: a
captured \`SceneTree\` lists and awaits \`process_frame\`, a \`SceneTreeTimer\` that
exists only as a returned object awaits its \`timeout\`, \`node_added\` delivers its
one argument, \`Input.joy_connection_changed\` connects and disconnects on a
singleton target, a freed emitter answers \`object_not_found\`, and at edit time
\`EditorSelection.selection_changed\` and a resource's \`changed\` both settle with
no eval tool registered.

The acceptance is falsifiable by construction rather than by flag. The
eval-backed \`await\` generated a snippet containing \`get_node(path)\`, so no
target that is not a node path could ever have reached it: every check above on
\`object:<n>\` or \`singleton:<Class>\` fails against the old implementation.

Five things were measured rather than assumed. A custom Rust callable reports no
argument count, which is what lets one implementation connect to signals of
every arity where a \`#[func]\` method cannot. \`ONE_SHOT\` does not cover the
deadline path, so the pending op disconnects explicitly on every settle. A
headless editor's \`_process\` does turn often enough for an edit-time await to
settle. \`Object::connect_ex\` is \`pub(crate)\` in gdext 0.5.5 and
\`connect_flags\` is the public door. And \`Curve.bake_resolution\` does not emit
\`changed\`, so the resource check triggers it with \`emit_changed\` through the
\`res://\` path instead (\`docs/api-gaps.md\`).

**Phase 18: the measurement, and a corrected tutorial sweep.** Phases 15, 16
and 17 changed the grading rules and hand-edited the prose here, but never
re-ran the audit, so every number in this document was three phases stale and
the headline claims of the last two phases were projections. This phase ran it.

The projections held exactly: best-of-both 0 at T2, editor 0, runtime 3460. The
class-reference tables above are now measured rather than replayed, against the
same 4.7 documentation build the phase 14 run used -- 1078 classes and 15390
members both reproduce, so the whole delta is the committed rule changes and
nothing is docs drift.

The tutorial half is where the correction is, and it is the phase 14 shape
again: rules asserting absences that later phases had closed. \`t2:io_page\`
blamed a handle gap that phase 16 shut -- \`FileAccess\` and \`DirAccess\` are
\`RefCounted\`, so \`gd_object\` builds them; what actually blocks them is that
\`open()\` is static and the target grammar names no class for a static call.
\`t5:accessibility\` graded six headings "nothing reaches it" on the strength of
\`AccessibilityServer\` being an untargetable singleton, which stopped being true
in phase 10 -- and reading the six pages shows they never went through
\`AccessibilityServer\` at all. They are \`DisplayServer.tts_*\`, \`OS.execute\`, a
\`StatusIndicator\` node, \`MenuBar.prefer_global_menu\`, and two project
settings: reachable by three separate mechanisms, none of them the one the rule
denied. And \`t2:compute_shader\` claimed a whole page was out of reach "until
phase 16", which had already happened. Tutorial actions graded T2 or worse move
314 to 303, again with no tool added for them.

The compute page split rather than flipping, because the runner only earned one
heading of it. *Accepted* by \`bun run phase18\`, with \`--disable-eval\`:
\`create_local_rendering_device\` on \`singleton:RenderingServer\` captures as a
\`RenderingDevice\` handle and answers \`get_device_name\` on a later call, so
obtaining a device is T1 -- and \`storage_buffer_create\` returns \`RID(...)\` as a
display string that \`buffer_get_data\` then refuses, so the six headings built
on the device stay T2 for the RID gap rather than the handle gap.

Three things were measured rather than assumed. \`--headless\` forces the dummy
rendering driver and answers \`null\` whatever \`--rendering-method\` says, and the
example project ships \`gl_compatibility\`, which has no \`RenderingDevice\`
either -- so this runner needs a display and a \`forward_plus\` engine, and it
stays out of \`ci:phases\` for the reason phase 6 does. A stringified RID fed
back to a method that wants one panics inside gdext's \`Object::call\`, contained
by the dispatcher's \`catch_unwind\` and reported as \`internal_error\` rather than
as a typed error (\`docs/api-gaps.md\`). And the tutorial rules had no equivalent
of \`staleClaims\`, which is why they rotted for two phases without failing
anything; \`staleSectionRules\` is now fatal in the same place, and it found a
dead \`t0:screenshot\` rule on its first run. Both guards live inside a
regeneration, which is the step an LFS-conscious phase skips, so
\`bun run coverage:check\` runs them and the tier summary and writes nothing.

**Phase 19: the static call, the RID, and the typed error.** All three items the
last \`### Next\` named, taken together because they sit on one call path and
each would have made the others worse alone.

\`class:<Class>\` is the fourth target scheme, and the only one that resolves to
no object. \`gd_node_call\` and \`gd_scene_node_call\` branch on it and go through
\`ClassDb::class_call_static\`; every other target-taking tool refuses it with one
shared message pointing at \`gd_classdb\`. An RID is now tagged in both
directions. The typed error is the reason the other two are usable at all: a
scheme that lets a caller name a class and fabricate an RID id creates two new
ways to pass a wrong argument, and both used to reach the client as
\`internal_error: handler panicked\`.

*Accepted* by \`bun run phase19\`, headless on both bridges, the editor half with
\`--disable-eval\`: \`class:FileAccess\` opens a file for writing and \`capture\`
names the \`FileAccess\` it returns, a second open reads back what the handle
wrote, \`class:DirAccess\` makes a directory that \`dir_exists\` then finds, an
instance method named through \`class:\` is refused as one rather than
dispatched, \`PhysicsServer2D.space_create\` hands back a tagged RID that
\`space_set_active\`, \`space_is_active\`, and \`free_rid\` each spend, and a string
where a method wants an RID comes back \`invalid_args\` naming the parameter and
both types. The game half repeats the static call and reads the world's space
RID off a captured \`World2D\`, then cross-checks \`area_get_param\` against
\`gd_physics world_get\`: 980 both ways. Physics is real under \`--headless\` where
rendering is not, so the runner is in \`ci:phases\`.

The phase 18 runner is the second acceptance, extended rather than replaced. Its
RID half asserted a boundary -- a stringified RID, and a call that refuses it --
and both are now false, so it asserts the round trip instead:
\`storage_buffer_create(16)\` returns a tagged RID and \`buffer_get_data\` reads 16
zero bytes back. It stays out of \`ci:phases\` for the reason it always was.

Four things were measured rather than assumed, two of them before any code was
written. \`ClassDB.class_call_static\` really does dispatch \`FileAccess.open\`,
checked through \`singleton:ClassDB\` on the shipped surface, so the scheme was
known to work before it existed; and \`class_get_method_list\` really does include
static methods, which the STATIC precheck depends on -- \`FileAccess.open\`
reports flags 33 against 5 for \`FileAccess.get_as_text\`. gdext exposes no public
accessor for \`CallError\`'s kind, so every dispatch failure maps to
\`invalid_args\`, which is sound because the \`has_method\` precheck above each
call site removes the method-existence kinds. And a fabricated RID id is safe:
the servers look one up in an owner table, so \`space_is_active\` on a made-up id
answers \`false\` rather than dereferencing (\`docs/api-gaps.md\`).

The correction is the same shape as phase 18's. \`docs/api-gaps.md\` recorded that
gdext 0.5.5 exposes no \`try_call\`, and that a typed error therefore needed a
ClassDB signature validator. The generated bindings say otherwise:
\`Object::call\` is \`try_call(...)\` with \`unwrap_or_else(|e| panic!("{e}"))\` after
it, so the panic phase 18 saw *was* the typed error, one line before it was
thrown away. Five call sites swapped, no validator.

The tutorial regrade is the phase 14 and 18 shape a third time. \`t2:io_page\`
blamed 13 headings on the static-call gap, and reading the pages shows three
different mechanisms: the static factories phase 19 closes (with \`Image\`,
\`AudioStream*\`, and \`JSON\` beside \`FileAccess\` and \`DirAccess\`, each confirmed
static rather than assumed), object handles that have worked since phase 16
(\`ZIPReader\`, \`ZIPPacker\`, \`GLTFDocument\`, \`GLTFState\`), and singleton
targeting that has worked since phase 10 (\`ProjectSettings.globalize_path\`,
\`OS.get_data_dir\`) -- all of them run live rather than inferred. Four headings
on that page were prose sitting in the action denominator.
\`t2:renderingdevice\` was stale for the same reason, and the one heading it still
won turns out to be architecture prose that never touched an RID. The compute
page splits rather than flipping, again: the buffer pair is earned, the SPIR-V
chain is not.

### Next

Nothing in the class reference, and nothing behind a naming gap: five generic
verbs, four target schemes, and a value form for the one thing that is neither an
object nor a name.

The clearest remaining item is small and specific. \`uniform_set_create\` takes a
typed \`Array[RDUniform]\`, and an \`args\` list builds an untyped \`Array\`; whether
the engine accepts one for the other is undemonstrated, and it is the last thing
between the compute page's three remaining headings and T1. It is the same typed
array asymmetry phase 16 met from the reading side, where gdext refused to
convert \`Array[Node]\` into \`Array<Variant>\`. One runner answers it either way.

Two smaller ones. The per-member via strings in the class-reference tables say
\`target: object:...\` for static methods, which \`class:<Class>\` has made merely
imprecise rather than wrong; fixing it means teaching \`extract-docs.ts\` to read
the \`static\` marker. And \`CallError\`'s kind is not public in gdext 0.5.5, so
every dispatch failure reports \`invalid_args\`; if a later gdext exposes it, the
split is one function.

What is left in the tutorials is not a naming problem. The largest clusters are
\`t2:gettext\` (31 headings, an editor menu action with no scripted entry point),
\`t2:plugin_authoring\` (27, writing plugin code rather than driving the editor),
\`t2:tilemap_editor_page\` (13, paint tools with no semantic equivalent), and
\`t2:custom_draw\` (15 across two rules, arbitrary \`_draw()\` work that needs a
script). Each is a tool decision rather than a grammar one.

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
  // The tutorial half of the same guarantee. Fatal for the same reason: a rule
  // that never wins is either dead or shadowed, and both mean the table is
  // reporting a reason nobody can reach.
  const inert = staleSectionRules(result.sections);
  if (inert.length > 0) {
    console.error(`section-rules.ts has ${inert.length} rule(s) that never win a heading:`);
    for (const id of inert) console.error(`  ${id}`);
    process.exit(1);
  }
  // --check runs the audit and both guards and writes nothing. Regenerating
  // stores a new 8 MB LFS version, so CLAUDE.md reserves it for when the
  // numbers are wanted -- which means a rule edit is likely to skip it, which
  // is exactly how the tutorial rules rotted for two phases. This is the cheap
  // door: after editing coverage-map.ts or section-rules.ts, run it.
  if (Bun.argv.includes("--check")) {
    const checked = summarise(result);
    console.log(
      `docs ${checked.docsVersion}: ${checked.members.total} members, ${checked.sections.actions} tutorial actions, ${checked.sections.unclassified} unclassified`,
    );
    console.log(`members by best tier: ${JSON.stringify(checked.members.byBestTier)}`);
    console.log(`tutorial headings by tier: ${JSON.stringify(checked.sections.byTier)}`);
    console.log("rules check out; nothing written");
    process.exit(0);
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
