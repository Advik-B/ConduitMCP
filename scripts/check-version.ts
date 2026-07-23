#!/usr/bin/env bun
// Release-gate version check: Cargo.toml, Cargo.lock, and both package.json
// files must agree, and when TAG is set (tag builds) it must equal v<version>.
// Run with `bun scripts/check-version.ts`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function cargoTomlVersion(): string {
  const text = readFileSync(join(repoRoot, "Cargo.toml"), "utf8");
  const match = text.match(/^\[workspace\.package\][^[]*?^version = "([^"]+)"/ms);
  if (!match?.[1]) {
    throw new Error("no workspace.package version in Cargo.toml");
  }
  return match[1];
}

function cargoLockVersion(): string {
  const text = readFileSync(join(repoRoot, "Cargo.lock"), "utf8");
  const match = text.match(/^name = "conduit"\nversion = "([^"]+)"/m);
  if (!match?.[1]) {
    throw new Error("no conduit entry in Cargo.lock");
  }
  return match[1];
}

function packageJsonVersion(relative: string): string {
  const parsed = JSON.parse(readFileSync(join(repoRoot, relative), "utf8")) as { version?: string };
  if (!parsed.version) {
    throw new Error(`no version in ${relative}`);
  }
  return parsed.version;
}

const versions: Record<string, string> = {
  "Cargo.toml": cargoTomlVersion(),
  "Cargo.lock": cargoLockVersion(),
  "package.json": packageJsonVersion("package.json"),
  "broker/package.json": packageJsonVersion(join("broker", "package.json")),
};

const distinct = new Set(Object.values(versions));
if (distinct.size !== 1) {
  const listing = Object.entries(versions)
    .map(([file, version]) => `${file}: ${version}`)
    .join(", ");
  console.error(`version mismatch: ${listing}`);
  process.exit(1);
}

const version = [...distinct][0];
const tag = process.env.TAG;
if (tag && tag !== `v${version}`) {
  console.error(`tag ${tag} does not match manifest version v${version}`);
  process.exit(1);
}

console.log(`version ${version} consistent${tag ? ` and matches tag ${tag}` : ""}`);
