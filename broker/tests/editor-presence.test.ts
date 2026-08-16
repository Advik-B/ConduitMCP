// The presence check decides whether launching an editor is sensible, and both
// failure directions cost something. A false negative opens a second editor on a
// project Godot expects to own. A false positive refuses to launch at all, and
// that one is not hypothetical: the first version matched on executable name
// alone, so a running game -- the same binary as the editor -- blocked every
// launch, and CI failed on exactly that.

import { describe, expect, test } from "bun:test";

import {
  editorPresence,
  foreignEditorAdvice,
  isEditorCommandLine,
  isGodotProcessName,
  parseUnix,
  parseWindows,
  projectPathFromCommandLine,
} from "../src/editor-presence.ts";

describe("isGodotProcessName", () => {
  test.each([
    "godot",
    "Godot",
    "godot4",
    "Godot_mono",
    "Godot_v4.7.1-stable_win64.exe",
    "Godot_v4.7.1-stable_linux.x86_64",
    // Linux ps truncates comm to 15 characters, so the real name never arrives.
    "Godot_v4.7.1-st",
  ])("matches %s", (name) => {
    expect(isGodotProcessName(name)).toBe(true);
  });

  test.each(["godot-conduit", "mygodottool", "chrome.exe", "node", "godotenv", ""])("rejects %s", (name) => {
    expect(isGodotProcessName(name)).toBe(false);
  });
});

describe("isEditorCommandLine", () => {
  test.each([
    "/usr/bin/godot4 --editor --path /home/a/game",
    "godot -e --path /home/a/game",
    "Godot_v4.7.1_win64.exe --path C:/game --editor",
  ])("recognises the editor in %s", (args) => {
    expect(isEditorCommandLine(args)).toBe(true);
  });

  // Each of these is a Godot that must not block an editor launch.
  test.each([
    "/usr/bin/godot4 --headless --path /home/a/game res://main.tscn",
    "godot --path /home/a/game res://phase9.tscn",
    "godot --headless --export-release Linux out.x86_64 --path /home/a/game",
  ])("does not mistake a game for an editor in %s", (args) => {
    expect(isEditorCommandLine(args)).toBe(false);
  });
});

describe("projectPathFromCommandLine", () => {
  test.each([
    ["godot --editor --path /home/a/game", "/home/a/game"],
    ["godot --editor --path=/home/a/game", "/home/a/game"],
    ['godot --editor --path "C:/My Games/thing"', "C:/My Games/thing"],
  ])("reads %s", (args, expected) => {
    expect(projectPathFromCommandLine(args)).toBe(expected);
  });

  test("is null when there is no --path", () => {
    expect(projectPathFromCommandLine("godot --editor")).toBeNull();
  });
});

describe("parseUnix", () => {
  test("classifies editors and games from one listing", () => {
    const stdout = [
      "  1234 /usr/bin/godot4 --editor --path /home/a/game",
      "  5678 node /srv/app.js",
      "   999 /opt/Godot_v4.7.1-stable_linux.x86_64 --headless --path /home/a/game res://main.tscn",
    ].join("\n");
    const parsed = parseUnix(stdout);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ pid: 1234, editor: true, projectPath: "/home/a/game" });
    expect(parsed[1]).toMatchObject({ pid: 999, editor: false });
  });

  test("survives empty and malformed lines", () => {
    expect(parseUnix("\n\n  not a line\nPID COMMAND\n")).toEqual([]);
  });
});

describe("parseWindows", () => {
  test("reads the CIM json, including the single-object form", () => {
    const one = JSON.stringify({
      ProcessId: 8112,
      Name: "Godot_v4.7.1-stable_win64.exe",
      CommandLine: 'Godot.exe --editor --path "C:/game"',
    });
    expect(parseWindows(one)).toEqual([
      { pid: 8112, name: "Godot_v4.7.1-stable_win64.exe", editor: true, projectPath: "C:/game" },
    ]);
  });

  test("tolerates a null command line and non-json output", () => {
    const row = JSON.stringify([{ ProcessId: 1, Name: "godot.exe", CommandLine: null }]);
    expect(parseWindows(row)[0]).toMatchObject({ pid: 1, editor: false, projectPath: null });
    expect(parseWindows("not json at all")).toEqual([]);
  });
});

function manager(connected: boolean, ourPid: number | null, games: number[] = []) {
  return {
    isEditorConnected: () => connected,
    getEditorProcess: () => (ourPid === null ? null : { pid: ourPid }),
    listGames: () => games.map((pid) => ({ pid })),
  };
}

describe("editorPresence", () => {
  // The probe runs against the real machine. Asserting on flags rather than on
  // foreign keeps it hermetic: a developer with Godot open must not fail this.
  test("reports a connected editor", async () => {
    const presence = await editorPresence(manager(true, null), "/home/a/game");
    expect(presence.connected).toBe(true);
    expect(foreignEditorAdvice(presence)).toBeNull();
  });

  test("reports a launch this broker started", async () => {
    const presence = await editorPresence(manager(false, 4242), "/home/a/game");
    expect(presence.launching).toBe(true);
  });

  test("never counts the editor this broker spawned as foreign", async () => {
    const presence = await editorPresence(manager(false, 4242), "/home/a/game");
    expect(presence.foreign.some((proc) => proc.pid === 4242)).toBe(false);
  });
});

describe("foreignEditorAdvice", () => {
  const editorOn = (projectPath: string | null) => ({
    connected: false,
    launching: false,
    probed: true,
    foreign: [{ pid: 1, name: "Godot_v4.7.1-stable_win64.exe", editor: true, projectPath }],
  });

  test("names the process and says not to open a second editor", () => {
    const advice = foreignEditorAdvice(editorOn("/home/a/game"));
    expect(advice).toContain("Godot_v4.7.1-stable_win64.exe");
    expect(advice).toContain("CONDUIT_ENABLE");
    expect(advice).toContain("second editor");
  });

  test("says nothing when an editor is already connected", () => {
    expect(foreignEditorAdvice({ ...editorOn(null), connected: true })).toBeNull();
  });

  test("says nothing when nothing foreign was found", () => {
    expect(foreignEditorAdvice({ connected: false, launching: false, probed: true, foreign: [] })).toBeNull();
  });
});
