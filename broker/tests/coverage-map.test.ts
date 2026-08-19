// Keeps the coverage audit honest as the tool surface moves.
//
// The audit's T0 claims come from a hand-written table (scripts/coverage/
// coverage-map.ts). A rule naming a tool that no longer exists would silently
// stop contributing coverage and the matrix would quietly understate the
// surface, so the table is checked against the real registration list here, the
// same way TOOL_GROUP_BY_NAME already is. These tests need no docs checkout.

import { describe, expect, test } from "bun:test";

import { T0_COVERAGE } from "../../scripts/coverage/coverage-map.ts";
import { SECTION_RULES, EXCLUDED_AREAS } from "../../scripts/coverage/section-rules.ts";
import { DEFAULT_FLAGS, MAXIMAL_FLAGS, capabilityIds, collectToolSurface } from "../../scripts/coverage/extract-tools.ts";
import { TOOL_GROUP_BY_NAME } from "../src/tool-registry.ts";

describe("the coverage map", () => {
  const registered = new Set(collectToolSurface(MAXIMAL_FLAGS).map((tool) => tool.name));

  test("every rule names a tool that is actually registered", () => {
    const unknown = [...new Set(T0_COVERAGE.map((rule) => rule.tool))].filter((tool) => !registered.has(tool));
    expect(unknown).toEqual([]);
  });

  test("no rule claims coverage without naming a member", () => {
    // A rule with no members is allowed only when it explains why in a note.
    const silent = T0_COVERAGE.filter((rule) => rule.members.length === 0 && !rule.note);
    expect(silent.map((rule) => rule.tool)).toEqual([]);
  });

  test("no rule names an empty class list", () => {
    expect(T0_COVERAGE.filter((rule) => rule.classes.length === 0)).toEqual([]);
  });
});

describe("the tool surface extractor", () => {
  const maximal = collectToolSurface(MAXIMAL_FLAGS);

  test("agrees with the group table on which tools exist", () => {
    const extracted = maximal.map((tool) => tool.name).sort();
    const grouped = Object.keys(TOOL_GROUP_BY_NAME).sort();
    expect(extracted).toEqual(grouped);
  });

  test("counts a consolidated tool by its ops, not as one capability", () => {
    const debug = maximal.find((tool) => tool.name === "gd_debug");
    expect(debug?.ops.length).toBeGreaterThan(1);
    expect(capabilityIds(maximal).length).toBeGreaterThan(maximal.length);
  });

  test("the default surface is a strict subset of the maximal one", () => {
    const defaults = collectToolSurface(DEFAULT_FLAGS).map((tool) => tool.name);
    const names = new Set(maximal.map((tool) => tool.name));
    expect(defaults.every((name) => names.has(name))).toBe(true);
    expect(defaults.length).toBeLessThan(maximal.length);
  });
});

describe("the section rules", () => {
  test("have unique ids", () => {
    const ids = SECTION_RULES.map((rule) => rule.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  test("every rule can match something", () => {
    const inert = SECTION_RULES.filter((rule) => !rule.pages && !rule.match);
    expect(inert).toEqual([]);
  });

  test("every excluded area states a reason", () => {
    const silent = Object.entries(EXCLUDED_AREAS).filter(([, reason]) => reason.trim().length === 0);
    expect(silent).toEqual([]);
  });
});
