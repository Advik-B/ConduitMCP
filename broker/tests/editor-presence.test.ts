// The presence check decides whether launching an editor or downloading an
// engine is sensible, so its two failure directions both cost something: a
// false negative opens a second editor on a project Godot expects to own, and a
// false positive refuses to launch on a machine with no Godot at all. The
// parsers and the name matcher are where either would come from.

import { describe, expect, test } from "bun:test";

import {
  editorPresence,
  foreignEditorAdvice,
  isGodotProcessName,
  parseTasklistCsv,
  parseUnix,
} from "../src/editor-presence.ts";

describe("isGodotProcessName", () => {
  test.each([
    "godot",
    "Godot",
    "godot4",
    "Godot_v4.7.1-stable_win64.exe",
    "Godot_v4.7.1-stable_linux.x86_64",
    "Godot_v4.4-stable_macos.universal",
  ])("matches %s", (name) => {
    expect(isGodotProcessName(name)).toBe(true);
  });

  // A substring test would match all of these, and each one would make the
  // broker refuse to launch an editor for no reason.
  test.each(["godot-conduit", "mygodottool", "chrome.exe", "node", "godotenv", ""])("rejects %s", (name) => {
    expect(isGodotProcessName(name)).toBe(false);
  });
});

describe("parseUnix", () => {
  test("picks Godot out of ps output and ignores everything else", () => {
    const stdout = ["  1234 godot4", "  5678 node", "   999 Godot_v4.7.1-stable_linux.x86_64", "  4321 bash"].join("\n");
    expect(parseUnix(stdout)).toEqual([
      { pid: 1234, name: "godot4" },
      { pid: 999, name: "Godot_v4.7.1-stable_linux.x86_64" },
    ]);
  });

  test("takes the basename, because macOS comm can be a full path", () => {
    expect(parseUnix("  42 /Applications/Godot.app/Contents/MacOS/Godot")).toEqual([{ pid: 42, name: "Godot" }]);
  });

  test("survives empty and malformed lines", () => {
    expect(parseUnix("\n\n  not a line\nPID COMMAND\n")).toEqual([]);
  });
});

describe("parseTasklistCsv", () => {
  test("reads the quoted image name and pid", () => {
    const stdout =
      '"Godot_v4.7.1-stable_win64.exe","8112","Console","1","180,000 K"\n"chrome.exe","44","Console","1","90 K"';
    expect(parseTasklistCsv(stdout)).toEqual([{ pid: 8112, name: "Godot_v4.7.1-stable_win64.exe" }]);
  });

  test("survives an empty listing", () => {
    expect(parseTasklistCsv("")).toEqual([]);
  });
});

function manager(connected: boolean, ourPid: number | null) {
  return {
    isEditorConnected: () => connected,
    getEditorProcess: () => (ourPid === null ? null : { pid: ourPid }),
  };
}

describe("editorPresence", () => {
  // The probe runs against the real machine here. Asserting on the flags rather
  // than on foreign keeps it hermetic: a developer with Godot open must not
  // fail the suite.
  test("reports a connected editor without consulting the process list", async () => {
    const presence = await editorPresence(manager(true, null));
    expect(presence.connected).toBe(true);
    expect(foreignEditorAdvice(presence)).toBeNull();
  });

  test("reports a launch this broker started", async () => {
    const presence = await editorPresence(manager(false, 4242));
    expect(presence.launching).toBe(true);
  });

  test("never counts the editor this broker spawned as foreign", async () => {
    const presence = await editorPresence(manager(false, 4242));
    expect(presence.foreign.some((proc) => proc.pid === 4242)).toBe(false);
  });
});

describe("foreignEditorAdvice", () => {
  test("names the process and says not to open a second editor", () => {
    const advice = foreignEditorAdvice({
      connected: false,
      launching: false,
      probed: true,
      foreign: [{ pid: 1, name: "Godot_v4.7.1-stable_win64.exe" }],
    });
    expect(advice).toContain("Godot_v4.7.1-stable_win64.exe");
    expect(advice).toContain("CONDUIT_ENABLE");
    expect(advice).toContain("second editor");
  });

  test("says nothing when an editor is already connected", () => {
    expect(
      foreignEditorAdvice({ connected: true, launching: false, probed: true, foreign: [{ pid: 1, name: "godot" }] }),
    ).toBeNull();
  });

  test("says nothing when the probe found nothing", () => {
    expect(foreignEditorAdvice({ connected: false, launching: false, probed: true, foreign: [] })).toBeNull();
  });
});
