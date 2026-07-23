#!/usr/bin/env bun
// Release-gate version check. The workspace Cargo.toml is the single source of
// the project version: the bridge reads it as CARGO_PKG_VERSION and the broker
// imports it directly, so this only verifies Cargo.lock was refreshed, that no
// package.json reintroduces its own version, and that a TAG (tag builds)
// matches v<version>. Run with `bun scripts/check-version.ts`.

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

function requireNoPackageJsonVersion(relative: string): void {
  const parsed = JSON.parse(readFileSync(join(repoRoot, relative), "utf8")) as { version?: string };
  if (parsed.version !== undefined) {
    console.error(`${relative} declares a version; the version lives in the workspace Cargo.toml only`);
    process.exit(1);
  }
}

const version = cargoTomlVersion();
const lockVersion = cargoLockVersion();
if (version !== lockVersion) {
  console.error(`Cargo.lock pins conduit ${lockVersion} but Cargo.toml says ${version}; run cargo check and commit the lock`);
  process.exit(1);
}

requireNoPackageJsonVersion("package.json");
requireNoPackageJsonVersion(join("broker", "package.json"));

const tag = process.env.TAG;
if (tag && tag !== `v${version}`) {
  console.error(`tag ${tag} does not match Cargo.toml version v${version}`);
  process.exit(1);
}

console.log(`version ${version} consistent${tag ? ` and matches tag ${tag}` : ""}`);
