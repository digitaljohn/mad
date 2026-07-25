#!/usr/bin/env node
// The version lives in three files that must agree, because three different
// tools own them: npm, cargo and Tauri's bundler. Set them all from one place.
//
//   node scripts/set-version.mjs 0.2.0
//   node scripts/set-version.mjs --check        # verify they already agree
//   node scripts/set-version.mjs --check 0.2.0  # ...and match this version
//
// `--check` is what CI runs against the git tag, so a release can never ship a
// binary whose version disagrees with the tag that produced it.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(root, "package.json");
const CARGO = join(root, "src-tauri", "Cargo.toml");
const CONF = join(root, "src-tauri", "tauri.conf.json");

const read = (p) => readFileSync(p, "utf8");
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Only the `version` on the first `[package]` key — not a dependency's. */
function cargoVersion(text) {
  const m = text.match(/^version\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("no version found in Cargo.toml");
  return m[1];
}

function current() {
  return {
    "package.json": JSON.parse(read(PKG)).version,
    "src-tauri/Cargo.toml": cargoVersion(read(CARGO)),
    "src-tauri/tauri.conf.json": JSON.parse(read(CONF)).version,
  };
}

function setAll(version) {
  const pkg = JSON.parse(read(PKG));
  pkg.version = version;
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");

  // Rewrite only the first `version =`, which belongs to [package].
  let cargo = read(CARGO);
  let replaced = false;
  cargo = cargo.replace(/^version\s*=\s*"[^"]+"/m, () => {
    replaced = true;
    return `version = "${version}"`;
  });
  if (!replaced) throw new Error("could not rewrite Cargo.toml version");
  writeFileSync(CARGO, cargo);

  // Keep tauri.conf.json's formatting stable: only the version line changes.
  const conf = read(CONF);
  const next = conf.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${version}"`);
  if (next === conf) throw new Error("could not rewrite tauri.conf.json version");
  writeFileSync(CONF, next);
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const version = args.find((a) => !a.startsWith("-"));

if (check) {
  const found = current();
  const values = [...new Set(Object.values(found))];
  let failed = false;

  if (values.length !== 1) {
    console.error("Versions disagree:");
    for (const [file, v] of Object.entries(found)) console.error(`  ${v}  ${file}`);
    failed = true;
  }
  if (version && values[0] !== version) {
    console.error(`Expected ${version}, found ${values[0]}`);
    failed = true;
  }
  if (failed) {
    console.error("\nRun: node scripts/set-version.mjs <version>");
    process.exit(1);
  }
  console.log(`version ${values[0]} — all three files agree`);
  process.exit(0);
}

if (!version) {
  console.error("Usage: node scripts/set-version.mjs <version> | --check [version]");
  process.exit(2);
}
if (!SEMVER.test(version)) {
  console.error(`"${version}" is not a semver version (expected e.g. 0.2.0)`);
  process.exit(2);
}

setAll(version);
for (const [file, v] of Object.entries(current())) console.log(`  ${v}  ${file}`);
console.log(`\nNext: commit, then \`git tag v${version} && git push --tags\``);
