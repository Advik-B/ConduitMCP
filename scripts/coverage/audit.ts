// Joins the Godot documentation inventory against the Conduit tool surface and
// emits the coverage matrix.
//
// The output grades reachability rather than answering yes/no, because
// gd_game_eval technically reaches everything and a yes/no report would
// therefore be uniformly "yes" and useless. The tiers are defined in
// docs/coverage-matrix.md; the short version is that T2 and worse are gaps
// against whitepaper 4.1, which asks for an equivalent action through the
// engine's own API rather than for arbitrary code that produces the effect.

import fs from "node:fs";
import path from "node:path";

import { T0_COVERAGE, type CoverageRule } from "./coverage-map.ts";
import { docsVersion, resolveDocsRoot } from "./docs-root.ts";
import { extractClasses, type ClassRecord, type MemberRecord } from "./extract-docs.ts";
import { extractSections, type SectionRecord } from "./extract-tutorials.ts";
import { DEFAULT_FLAGS, MAXIMAL_FLAGS, capabilityIds, collectToolSurface, type ToolRecord } from "./extract-tools.ts";
import { EXCLUDED_AREAS, SECTION_RULES, type SectionRule } from "./section-rules.ts";

export type Tier = "T0" | "T1" | "T2" | "T3" | "T4" | "T5";

export const TIER_LABEL: Record<Tier, string> = {
  T0: "dedicated tool",
  T1: "generic reflection tool",
  T2: "eval only",
  T3: "editor control-tree driving",
  T4: "pixels only",
  T5: "no path",
};

export interface MemberVerdict {
  class: string;
  classKind: ClassRecord["kind"];
  member: string;
  kind: MemberRecord["kind"];
  deprecated: boolean;
  experimental: boolean;
  runtime: { tier: Tier; via: string };
  editor: { tier: Tier; via: string };
  best: Tier;
  /** Which eval a T2 verdict depends on; editor eval is off by default. */
  evalScope: "game" | "editor" | null;
}

/** Ancestors first, so a rule on Node applies to every node class. */
function lineage(record: ClassRecord): string[] {
  return [record.name, ...record.inherits];
}

function matchRule(record: ClassRecord, member: string, side: "runtime" | "editor", rules: CoverageRule[]): CoverageRule | null {
  const chain = lineage(record);
  for (const rule of rules) {
    if (rule.side !== side && rule.side !== "both") continue;
    if (!rule.classes.some((name) => chain.includes(name))) continue;
    if (!rule.members.includes(member)) continue;
    return rule;
  }
  return null;
}

function tierRuntime(record: ClassRecord, member: MemberRecord, rules: CoverageRule[]): { tier: Tier; via: string } {
  const rule = matchRule(record, member.name, "runtime", rules);
  if (rule) return { tier: "T0", via: rule.tool };
  if (record.kind === "node") {
    if (member.kind === "method") return { tier: "T1", via: "gd_node_call" };
    if (member.kind === "property") return { tier: "T1", via: "gd_node_get_property / gd_node_set_property" };
    return { tier: "T1", via: "gd_signal" };
  }
  // Singletons became addressable when the target grammar landed: the same
  // generic tools accept `singleton:<Class>`, resolved through
  // Engine::get_singleton (bridge/src/handlers/target.rs). Signals joined them
  // when gd_signal learned the grammar too; before that the signal tools were
  // the only generic verbs still limited to a node path.
  if (record.kind === "singleton") {
    if (member.kind === "method") return { tier: "T1", via: "gd_node_call (target: singleton:...)" };
    if (member.kind === "property") {
      return { tier: "T1", via: "gd_node_get_property / gd_node_set_property (target: singleton:...)" };
    }
    return { tier: "T1", via: "gd_signal (target: singleton:...)" };
  }
  // Object-kind classes became addressable when the handle table landed: an
  // object with no name is constructed with gd_object or captured from a call
  // that hands one out, and then named as `target: object:<n>`
  // (bridge/src/handles.rs).
  if (record.kind === "object") {
    if (member.kind === "method") return { tier: "T1", via: "gd_node_call (target: object:...)" };
    if (member.kind === "property") {
      return { tier: "T1", via: "gd_node_get_property / gd_node_set_property (target: object:...)" };
    }
    return { tier: "T1", via: "gd_signal (target: object:...)" };
  }
  // Resources are deliberately NOT regraded here. A handle reaches a runtime
  // resource when some call hands one out -- World3D through get_world_3d is
  // the motivating case -- but that is conditional on such a call existing,
  // and grading 3475 members T1 on a conditional would move the runtime row by
  // thousands on a claim the acceptance does not make. The resource verbs
  // remain edit-time (they load and save through res:// paths).
  return { tier: "T2", via: "gd_game_eval" };
}

function tierEditor(record: ClassRecord, member: MemberRecord, rules: CoverageRule[]): { tier: Tier; via: string } {
  const rule = matchRule(record, member.name, "editor", rules);
  if (rule) return { tier: "T0", via: rule.tool };
  if (record.kind === "node") {
    if (member.kind === "property") return { tier: "T1", via: "gd_scene_node_get_property / gd_scene_node_set_property" };
    if (member.kind === "signal") return { tier: "T1", via: "gd_scene_signal" };
    return { tier: "T1", via: "gd_scene_node_call" };
  }
  if (record.kind === "singleton") {
    if (member.kind === "method") return { tier: "T1", via: "gd_scene_node_call (target: singleton:...)" };
    if (member.kind === "property") {
      return { tier: "T1", via: "gd_scene_node_get_property / gd_scene_node_set_property (target: singleton:...)" };
    }
    return { tier: "T1", via: "gd_scene_signal (target: singleton:...)" };
  }
  // A resource's signals are the one member kind the resource verbs do not
  // reach: gd_scene_signal names the emitter through the target grammar, and a
  // res:// path enters that grammar as a handle -- ResourceLoader.load on a
  // singleton target with capture: true. Unconditional at edit time, which is
  // the same assumption gd_resource_* already makes.
  if (record.kind === "resource") {
    if (member.kind === "property") return { tier: "T1", via: "gd_resource_get_property / gd_resource_set_property" };
    if (member.kind === "method") return { tier: "T1", via: "gd_resource_call" };
    return { tier: "T1", via: "gd_scene_signal (target: object:..., captured from ResourceLoader.load)" };
  }
  // The editor half of the handle table, reached the same way through
  // gd_scene_object and the gd_scene_node_* verbs.
  if (record.kind === "object") {
    if (member.kind === "method") return { tier: "T1", via: "gd_scene_node_call (target: object:...)" };
    if (member.kind === "property") {
      return { tier: "T1", via: "gd_scene_node_get_property / gd_scene_node_set_property (target: object:...)" };
    }
    return { tier: "T1", via: "gd_scene_signal (target: object:...)" };
  }
  return { tier: "T2", via: "gd_editor_eval" };
}

/**
 * Claims in the coverage map that the documentation does not back: a named class
 * that does not exist, or a member that does not. Godot documents accessors as
 * properties rather than as get_x/set_x methods, so a hand-written rule drifts
 * toward accessor names that were never in the reference; without this check the
 * rule silently matches nothing and the matrix understates T0 coverage.
 */
export function staleClaims(classes: ClassRecord[], rules: CoverageRule[] = T0_COVERAGE): string[] {
  const byName = new Map(classes.map((record) => [record.name, record]));
  const membersOf = (name: string): Set<string> | null => {
    const record = byName.get(name);
    if (!record) return null;
    const names = new Set(record.members.map((member) => member.name));
    for (const ancestor of record.inherits) {
      for (const member of byName.get(ancestor)?.members ?? []) names.add(member.name);
    }
    return names;
  };
  const problems: string[] = [];
  for (const rule of rules) {
    for (const className of rule.classes) {
      const known = membersOf(className);
      if (!known) {
        problems.push(`${rule.tool}: class ${className} is not in the documentation`);
        continue;
      }
      const missing = rule.members.filter((member) => !known.has(member));
      if (missing.length > 0) problems.push(`${rule.tool}: ${className} has no ${missing.join(", ")}`);
    }
  }
  return problems;
}

const TIER_RANK: Tier[] = ["T0", "T1", "T2", "T3", "T4", "T5"];

function better(a: Tier, b: Tier): Tier {
  return TIER_RANK.indexOf(a) <= TIER_RANK.indexOf(b) ? a : b;
}

export function classifyMembers(classes: ClassRecord[], rules: CoverageRule[] = T0_COVERAGE): MemberVerdict[] {
  const verdicts: MemberVerdict[] = [];
  for (const record of classes) {
    // Variant built-ins are values, not engine actions; their wire coverage is
    // recorded in docs/api-gaps.md. @GlobalScope and @GDScript are language
    // surface and get their own row in the report rather than member rows.
    if (record.kind === "builtin" || record.kind === "global") continue;
    for (const member of record.members) {
      const runtime = tierRuntime(record, member, rules);
      const editor = tierEditor(record, member, rules);
      const best = better(runtime.tier, editor.tier);
      const winner = runtime.tier === best ? runtime : editor;
      verdicts.push({
        class: record.name,
        classKind: record.kind,
        member: member.name,
        kind: member.kind,
        deprecated: record.deprecated || member.deprecated,
        experimental: record.experimental || member.experimental,
        runtime,
        editor,
        best,
        evalScope: best === "T2" ? (winner.via.includes("editor") ? "editor" : "game") : null,
      });
    }
  }
  return verdicts;
}

export interface SectionVerdict extends SectionRecord {
  tier: Tier;
  via: string;
  rule: string;
  /** Concept headings explain rather than instruct, so they are never gaps. */
  kind: "action" | "concept" | "excluded" | "unclassified";
  excluded: boolean;
  exclusionReason: string | null;
}

function excludedArea(section: SectionRecord): { excluded: boolean; reason: string | null } {
  for (const [prefix, reason] of Object.entries(EXCLUDED_AREAS)) {
    if (section.page === prefix || section.page.startsWith(`${prefix}/`) || section.area === prefix) {
      return { excluded: true, reason };
    }
  }
  return { excluded: false, reason: null };
}

function matchSection(section: SectionRecord, rules: SectionRule[]): SectionRule | null {
  // Page id and heading only. Including the lead paragraph sounded better and
  // measured worse: a broad needle like "import" then matches any page whose
  // first sentence happens to mention importing, and a whole area flips tier on
  // one incidental word.
  const haystack = `${section.page} ${section.title}`.toLowerCase();
  for (const rule of rules) {
    if (rule.pages && !rule.pages.some((page) => section.page.startsWith(page))) continue;
    if (rule.match && !rule.match.some((needle) => haystack.includes(needle.toLowerCase()))) continue;
    if (!rule.pages && !rule.match) continue;
    return rule;
  }
  return null;
}

/**
 * Section rules that never win a heading.
 *
 * `staleClaims` does this for the class-reference table and is fatal; the
 * tutorial rules had no equivalent, and rotted for two phases without anything
 * failing -- phase 16 closed the object-handle gap and three rules went on
 * citing it, one of them naming the phase that closed it.
 *
 * The check has to be "never wins", not "matches something in isolation".
 * `matchSection` is first-match-wins and several rules use `match: [""]` to
 * claim a whole page, so a rule fully shadowed by an earlier one still matches
 * everything when asked on its own. Shadowing is precisely how a stale rule
 * hides.
 */
export function staleSectionRules(sections: SectionRecord[], rules: SectionRule[] = SECTION_RULES): string[] {
  const winners = new Set(classifySections(sections, rules).map((section) => section.rule));
  // Action rules only. A concept rule is a keyword needle whose job is to keep
  // prose out of the denominator, and a list of them that over-provides costs
  // nothing; an action rule that never wins is a coverage claim reaching
  // nothing, which is the thing worth failing on.
  return rules.filter((rule) => rule.kind === "action" && !winners.has(rule.id)).map((rule) => rule.id);
}

export function classifySections(sections: SectionRecord[], rules: SectionRule[] = SECTION_RULES): SectionVerdict[] {
  return sections.map((section) => {
    const exclusion = excludedArea(section);
    if (exclusion.excluded) {
      return { ...section, tier: "T0", via: "-", rule: "-", kind: "excluded", excluded: true, exclusionReason: exclusion.reason };
    }
    const rule = matchSection(section, rules);
    return {
      ...section,
      tier: rule?.tier ?? "T5",
      via: rule?.via ?? "unclassified",
      rule: rule?.id ?? "unmatched",
      kind: rule?.kind ?? "unclassified",
      excluded: false,
      exclusionReason: null,
    };
  });
}

function tally<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

export interface AuditResult {
  docsVersion: string;
  classes: ClassRecord[];
  members: MemberVerdict[];
  sections: SectionVerdict[];
  tools: { maximal: ToolRecord[]; defaultNames: string[] };
}

export function runAudit(root: string): AuditResult {
  const classes = extractClasses(root);
  const maximal = collectToolSurface(MAXIMAL_FLAGS);
  const defaults = collectToolSurface(DEFAULT_FLAGS);
  return {
    docsVersion: docsVersion(root),
    classes,
    members: classifyMembers(classes),
    sections: classifySections(extractSections(root)),
    tools: { maximal, defaultNames: defaults.map((record) => record.name) },
  };
}

export function summarise(result: AuditResult) {
  const inScope = result.sections.filter((section) => !section.excluded);
  const actions = inScope.filter((section) => section.kind === "action");
  return {
    docsVersion: result.docsVersion,
    classes: {
      total: result.classes.length,
      byKind: tally(result.classes, (record) => record.kind),
    },
    members: {
      total: result.members.length,
      byBestTier: tally(result.members, (verdict) => verdict.best),
      byRuntimeTier: tally(result.members, (verdict) => verdict.runtime.tier),
      byEditorTier: tally(result.members, (verdict) => verdict.editor.tier),
      byKind: tally(result.members, (verdict) => verdict.kind),
    },
    sections: {
      total: result.sections.length,
      excluded: result.sections.length - inScope.length,
      inScope: inScope.length,
      concepts: inScope.filter((verdict) => verdict.kind === "concept").length,
      actions: actions.length,
      byTier: tally(actions, (verdict) => verdict.tier),
      unclassified: inScope.filter((verdict) => verdict.kind === "unclassified").length,
    },
    tools: {
      maximal: result.tools.maximal.length,
      default: result.tools.defaultNames.length,
      capabilities: capabilityIds(result.tools.maximal).length,
    },
  };
}

if (import.meta.main) {
  const root = resolveDocsRoot();
  const result = runAudit(root);
  const summary = summarise(result);
  if (Bun.argv.includes("--json")) {
    const out = path.join(import.meta.dir, "..", "..", "docs", "coverage-matrix.json");
    fs.writeFileSync(out, `${JSON.stringify({ summary, members: result.members, sections: result.sections }, null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
  console.log(JSON.stringify(summary, null, 2));
}
