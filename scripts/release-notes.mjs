#!/usr/bin/env node
// CHANGELOG.md is the single source of what changed in a release. This pulls
// one version's section out of it so the release pipeline never has to have
// its own, second, inevitably-diverging copy of the notes.
//
//   node scripts/release-notes.mjs 0.2.3            # the section, as markdown
//   node scripts/release-notes.mjs --plain 0.2.3    # flattened to plain text
//   node scripts/release-notes.mjs --check 0.2.3    # is there a section at all?
//
// `--check` runs in the release preflight, so a tag with no changelog entry
// fails in ten seconds rather than publishing a release that says nothing.
// `--plain` feeds latest.json's `notes`, which the app shows in a *native*
// dialog — markdown would be rendered there as literal `**asterisks**`.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = join(root, "CHANGELOG.md");

/**
 * The body of `## <version> …`, up to the next `## ` heading.
 * Returns "" when there is no such section, or it is empty.
 */
export function extract(text, version) {
  const lines = text.split("\n");
  // Match the version as a whole token: `## 0.2.3` must not match `## 0.2.30`.
  const heading = new RegExp(`^##\\s+v?${version.replace(/\./g, "\\.")}(\\s|$)`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) return "";

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * Markdown flattened for a native dialog: no emphasis markers, no link
 * syntax, no code fences, and each bullet on one line regardless of how the
 * changelog happens to be wrapped.
 */
export function plain(markdown) {
  const out = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();

    if (/^```/.test(line)) continue;
    if (/^###+\s/.test(line)) {
      out.push({ text: line.replace(/^###+\s+/, "").replace(/:?$/, ":"), open: false });
      continue;
    }
    if (/^\s*[-*]\s/.test(line)) {
      // Nested bullets indent; top-level ones get a marker.
      const indent = /^\s{2,}/.test(line) ? "   " : "";
      out.push({ text: `${indent}• ${line.replace(/^\s*[-*]\s+/, "")}`, open: true });
      continue;
    }
    if (line.trim() === "") {
      out.push({ text: "", open: false });
      continue;
    }
    // A continuation of the previous bullet or paragraph, not a new one.
    const prev = out[out.length - 1];
    if (prev && prev.text !== "") {
      prev.text += ` ${line.trim()}`;
      continue;
    }
    out.push({ text: line.trim(), open: true });
  }

  return out
    .map((l) => l.text)
    .join("\n")
    .replace(/\*\*(.+?)\*\*/g, "$1") // bold
    .replace(/(^|\W)\*(\S[^*]*?)\*(?=\W|$)/g, "$1$2") // italic, not a bare *
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links keep their text
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const asPlain = args.includes("--plain");
  const version = args.find((a) => !a.startsWith("-"));

  if (!version) {
    console.error("Usage: node scripts/release-notes.mjs [--check|--plain] <version>");
    process.exit(2);
  }

  const section = extract(readFileSync(CHANGELOG, "utf8"), version);

  if (!section) {
    console.error(`No CHANGELOG.md section for ${version}.`);
    console.error(`Add a "## ${version} — <date>" heading describing what changed,`);
    console.error("so the release and the in-app update prompt can say something.");
    process.exit(1);
  }

  if (check) {
    console.log(`${version} — ${section.split("\n").length} lines of release notes`);
    return;
  }

  console.log(asPlain ? plain(section) : section);
}

// Run as a CLI, but stay importable: `extract` and `plain` are worth reaching
// for from a `node -e` one-liner when checking how notes will actually read.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
