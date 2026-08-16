// The engine installer's failure modes are quiet ones: a wrong asset name is a
// 404 the user reads as "Godot is down", a mismatched checksum parse refuses a
// perfectly good release, and a missed marker overwrites somebody's own engine.
// The asset names in particular are not derivable -- the .NET builds differ from
// the standard ones in three separate ways -- so they are asserted literally
// against the 4.7.1-stable release listing.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { detectEngine, digestFor, engineAssetName, listInstalledEngines, versionDir } from "../src/godot-install.ts";

const TAG = "4.7.1-stable";
const work = mkdtempSync(join(os.tmpdir(), "conduit-engine-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("engineAssetName", () => {
  test.each([
    ["linux", "x64", false, "Godot_v4.7.1-stable_linux.x86_64"],
    ["linux", "arm64", false, "Godot_v4.7.1-stable_linux.arm64"],
    ["win32", "x64", false, "Godot_v4.7.1-stable_win64.exe"],
    ["win32", "arm64", false, "Godot_v4.7.1-stable_windows_arm64.exe"],
    ["darwin", "arm64", false, "Godot_v4.7.1-stable_macos.universal"],
    ["darwin", "x64", false, "Godot_v4.7.1-stable_macos.universal"],
  ])("standard %s/%s", (platform, arch, mono, expected) => {
    expect(engineAssetName(TAG, mono, platform, arch)).toBe(expected);
  });

  // Three independent differences from the standard names, every one of which
  // has been got wrong by assuming the .NET name is the standard name with an
  // infix: Linux swaps the dot before the architecture for an underscore,
  // Windows drops the .exe, macOS keeps its dot.
  test.each([
    ["linux", "x64", true, "Godot_v4.7.1-stable_mono_linux_x86_64"],
    ["linux", "arm64", true, "Godot_v4.7.1-stable_mono_linux_arm64"],
    ["win32", "x64", true, "Godot_v4.7.1-stable_mono_win64"],
    ["win32", "arm64", true, "Godot_v4.7.1-stable_mono_windows_arm64"],
    ["darwin", "arm64", true, "Godot_v4.7.1-stable_mono_macos.universal"],
  ])(".NET %s/%s", (platform, arch, mono, expected) => {
    expect(engineAssetName(TAG, mono, platform, arch)).toBe(expected);
  });

  test("refuses a platform Godot publishes no editor for", () => {
    expect(() => engineAssetName(TAG, false, "freebsd", "x64")).toThrow(/no Godot editor archive/);
    expect(() => engineAssetName(TAG, false, "linux", "mips")).toThrow(/linux\/mips/);
  });
});

describe("digestFor", () => {
  const asset = "Godot_v4.7.1-stable_linux.x86_64.zip";
  const hash = "a".repeat(128);

  test("reads a plain two-column sums file", () => {
    expect(digestFor(`${hash}  ${asset}\n${"b".repeat(128)}  other.zip`, asset)).toBe(hash);
  });

  test("ignores the binary-mode asterisk", () => {
    expect(digestFor(`${hash} *${asset}`, asset)).toBe(hash);
  });

  // Godot's sums files list some assets with a path in front. An exact compare
  // would report a perfectly good release as unlisted and refuse to install.
  test("matches an entry listed with a path", () => {
    expect(digestFor(`${hash}  ./${asset}`, asset)).toBe(hash);
    expect(digestFor(`${hash}  releases/4.7.1/${asset}`, asset)).toBe(hash);
  });

  test("returns null when the asset is absent", () => {
    expect(digestFor(`${hash}  something-else.zip`, asset)).toBeNull();
    expect(digestFor("", asset)).toBeNull();
  });
});

describe("versionDir", () => {
  test("gives the .NET build its own directory so both can coexist", () => {
    expect(versionDir("/engines", TAG, false)).not.toBe(versionDir("/engines", TAG, true));
    expect(versionDir("/engines", TAG, true)).toContain("-mono");
  });
});

// The install layout is asserted through a fake rather than a download: what
// matters is that detection agrees with what the installer writes.
//
// Laid out for the host platform, so these run everywhere rather than skipping
// on two of the three. Detection decides whether an engine gets overwritten, so
// it is the last thing that should only be exercised on Linux.
function fakeInstall(root: string, tag: string, mono: boolean, marker: boolean): void {
  const dir = versionDir(root, tag, mono);
  mkdirSync(dir, { recursive: true });
  if (process.platform === "darwin") {
    const macos = join(dir, mono ? "Godot_mono.app" : "Godot.app", "Contents", "MacOS");
    mkdirSync(macos, { recursive: true });
    writeFileSync(join(macos, "Godot"), "");
  } else if (process.platform === "win32") {
    writeFileSync(join(dir, `Godot_v${tag}${mono ? "_mono" : ""}_win64.exe`), "");
  } else {
    writeFileSync(join(dir, `Godot_v${tag}${mono ? "_mono" : ""}_linux.x86_64`), "");
  }
  if (marker) {
    writeFileSync(join(dir, ".conduit-engine"), `${tag}\n`);
  }
}

function fakeBinaryName(tag: string): string {
  if (process.platform === "win32") {
    return `Godot_v${tag}_win64.exe`;
  }
  return `Godot_v${tag}_linux.x86_64`;
}

describe("detectEngine", () => {
  test("reports missing for a root with nothing in it", () => {
    const root = join(work, "empty");
    mkdirSync(root, { recursive: true });
    expect(detectEngine(root, TAG).state).toBe("missing");
  });

  test("distinguishes an install of its own from somebody else's", () => {
    const root = join(work, "mixed");
    fakeInstall(root, TAG, false, true);
    fakeInstall(root, "4.6-stable", false, false);
    expect(detectEngine(root, TAG).state).toBe("current");
    // No marker: an engine that arrived some other way, which force is for.
    expect(detectEngine(root, "4.6-stable").state).toBe("unmanaged");
  });

  test("keeps the standard and .NET builds of one version apart", () => {
    const root = join(work, "both");
    fakeInstall(root, TAG, false, true);
    expect(detectEngine(root, TAG, false).state).toBe("current");
    expect(detectEngine(root, TAG, true).state).toBe("missing");

    fakeInstall(root, TAG, true, true);
    expect(listInstalledEngines(root).filter((engine) => engine.mono)).toHaveLength(1);
    expect(listInstalledEngines(root)).toHaveLength(2);
  });

  // The .NET archives unpack a directory with the executable inside it, so
  // detection has to look one level down as well as directly.
  test("finds a binary nested one level down, as the .NET archives unpack it", () => {
    const root = join(work, "nested");
    const dir = versionDir(root, TAG, true);
    const inner = join(dir, `Godot_v${TAG}_mono_win64`);
    mkdirSync(inner, { recursive: true });
    if (process.platform === "darwin") {
      const macos = join(inner, "Godot_mono.app", "Contents", "MacOS");
      mkdirSync(macos, { recursive: true });
      writeFileSync(join(macos, "Godot"), "");
    } else {
      writeFileSync(join(inner, fakeBinaryName(TAG)), "");
    }
    const detected = detectEngine(root, TAG, true);
    expect(detected.state).toBe("unmanaged");
    expect(detected.binary).not.toBeNull();
  });
});

describe("listInstalledEngines", () => {
  test("is empty rather than throwing when the root does not exist", () => {
    expect(listInstalledEngines(join(work, "nope"))).toEqual([]);
  });

  test("skips the staging directory an interrupted install leaves behind", () => {
    const root = join(work, "staging");
    fakeInstall(root, TAG, false, true);
    const staging = join(root, `.${TAG}-install-tmp`);
    mkdirSync(staging, { recursive: true });
    if (process.platform === "darwin") {
      mkdirSync(join(staging, "Godot.app", "Contents", "MacOS"), { recursive: true });
      writeFileSync(join(staging, "Godot.app", "Contents", "MacOS", "Godot"), "");
    } else {
      writeFileSync(join(staging, fakeBinaryName(TAG)), "");
    }
    expect(listInstalledEngines(root).map((engine) => engine.tag)).toEqual([TAG]);
  });
});
