import { afterEach, describe, expect, test } from "bun:test";

import { listEditorTokens, listGameTokens, listTokens } from "../src/endpoint.ts";
import { envFlag } from "../src/env.ts";

const isWindows = process.platform === "win32";
const RUNTIME_DIR = isWindows ? "\\\\.\\pipe\\" : "/tmp/conduit-test";

// On Unix the tokens are .sock filenames; on Windows they are bare pipe names.
function entries(names: string[]): string[] {
  return isWindows ? names : names.map((name) => `${name}.sock`);
}

const previousTcp = process.env.CONDUIT_TCP;

afterEach(() => {
  if (previousTcp === undefined) {
    delete process.env.CONDUIT_TCP;
  } else {
    process.env.CONDUIT_TCP = previousTcp;
  }
});

describe("listTokens", () => {
  test("returns tokens matching the prefix, stripped of the .sock suffix on Unix", () => {
    const readDir = () => entries(["conduit-editor-aabbccdd", "conduit-game-aabbccdd-1234", "unrelated"]);
    expect(listEditorTokens(RUNTIME_DIR, readDir)).toEqual(["conduit-editor-aabbccdd"]);
    expect(listGameTokens(RUNTIME_DIR, undefined, readDir)).toEqual(["conduit-game-aabbccdd-1234"]);
  });

  test("scopes game tokens to a project hash", () => {
    const readDir = () => entries(["conduit-game-aabbccdd-1", "conduit-game-aabbccdd-2", "conduit-game-99887766-3"]);
    expect(listGameTokens(RUNTIME_DIR, "aabbccdd", readDir)).toEqual(["conduit-game-aabbccdd-1", "conduit-game-aabbccdd-2"]);
  });

  test("returns empty when the directory cannot be read", () => {
    expect(
      listTokens(RUNTIME_DIR, "conduit-editor-", () => {
        throw new Error("ENOENT");
      }),
    ).toEqual([]);
  });

  test("returns empty and does not read the directory under CONDUIT_TCP", () => {
    process.env.CONDUIT_TCP = "1";
    let read = false;
    const result = listEditorTokens(RUNTIME_DIR, () => {
      read = true;
      return entries(["conduit-editor-aabbccdd"]);
    });
    // Under TCP the endpoint is a hash-derived port with no namespace presence,
    // so an empty result means "cannot tell", not "none running".
    expect(result).toEqual([]);
    expect(read).toBe(false);
  });

  test("CONDUIT_TCP=0 does not enable TCP, so scanning still works", () => {
    process.env.CONDUIT_TCP = "0";
    expect(listEditorTokens(RUNTIME_DIR, () => entries(["conduit-editor-aabbccdd"]))).toEqual(["conduit-editor-aabbccdd"]);
  });
});

describe("envFlag", () => {
  test("unset and empty are off", () => {
    expect(envFlag(undefined)).toBe(false);
    expect(envFlag("")).toBe(false);
  });

  test("0, false, no, and off are off", () => {
    for (const value of ["0", "false", "FALSE", "no", "off", " 0 "]) {
      expect(envFlag(value)).toBe(false);
    }
  });

  test("1, true, and any other value are on", () => {
    for (const value of ["1", "true", "yes", "enabled"]) {
      expect(envFlag(value)).toBe(true);
    }
  });
});
