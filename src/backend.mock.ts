// The in-memory demo backend a plain browser runs against (`npm run dev`).
// Split from backend.ts so the coverage report measures it: this is what the
// UI tests lean on, and its behaviour has to match the Rust commands it
// stands in for.

import {
  CONFLICT,
  type Backend,
  type Entry,
  type SearchHit,
} from "./backend";

const DEMO_IMAGE =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300"><rect width="640" height="300" fill="#30302e"/><circle cx="320" cy="130" r="64" fill="#d97757"/><text x="320" y="240" text-anchor="middle" fill="#faf9f5" font-family="Georgia" font-size="22">demo image</text></svg>`,
  );

const DEMO_DOC = `# Welcome to mad

A **tiny** markdown editor with WYSIWYG editing. Type \`/\` for blocks — tables, images, code, quotes.

## Tables

| Feature | Status | Notes |
| --- | --- | --- |
| WYSIWYG | done | powered by Milkdown Crepe |
| Tables | done | slash command → table |
| Images | done | saved next to the file |

## Images

![demo](${DEMO_IMAGE})

## Code

\`\`\`ts
const answer = 42;
console.log("hello from mad");
\`\`\`

## Links

Links to other notes open right here — try [README](./README.md) or
[an idea](journal/ideas.md). [The web](https://example.com) opens in your
browser instead.

> Quotes work too. Select text to see the formatting toolbar.

- [x] folder browser
- [x] WYSIWYG editing
- [ ] your notes here
`;

export function mockBackend(): Backend {
  const files = new Map<string, string>([
    ["/demo/welcome.md", DEMO_DOC],
    ["/demo/README.md", "# README\n\nJust a demo file.\n"],
    ["/demo/demo image.png", ""],
    ["/demo/journal/2026-07-23.md", "# Today\n\nShipped a tiny editor.\n"],
    ["/demo/journal/ideas.md", "# Ideas\n\n- more themes\n"],
  ]);
  const dirs = new Set(["/demo", "/demo/journal"]);
  let rev = 0;
  const stamps = new Map<string, string>();
  const stamp = (path: string) => stamps.get(path) ?? "";
  const touch = (path: string) => stamps.set(path, String(++rev));
  for (const p of files.keys()) touch(p);

  return {
    pickFolder: async () => "/demo",
    listDir: async (path) => {
      const prefix = path.replace(/\/$/, "") + "/";
      const out: Entry[] = [];
      for (const d of dirs) {
        if (d !== path && d.startsWith(prefix) && !d.slice(prefix.length).includes("/"))
          out.push({ name: d.slice(prefix.length), path: d, is_dir: true });
      }
      for (const f of files.keys()) {
        if (f.startsWith(prefix) && !f.slice(prefix.length).includes("/"))
          out.push({ name: f.slice(prefix.length), path: f, is_dir: false });
      }
      out.sort((a, b) =>
        a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1,
      );
      return out;
    },
    readFile: async (path) => {
      const c = files.get(path);
      if (c === undefined) throw new Error(`not found: ${path}`);
      return { content: c, stamp: stamp(path) };
    },
    fileStamp: async (path) => stamp(path),
    writeFile: async (path, content, expect) => {
      if (expect !== null && stamp(path) !== expect) throw new Error(CONFLICT);
      files.set(path, content);
      touch(path);
      return stamp(path);
    },
    createFile: async (dir, name) => {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let target = `${dir}/${name}`;
      for (let n = 2; files.has(target); n++) target = `${dir}/${stem} ${n}${ext}`;
      files.set(target, "");
      touch(target);
      return target;
    },
    saveImage: async (dir, name) => {
      // Persist into the mock FS (deduped) so the tree shows it, like Rust.
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let base = name;
      for (let n = 2; files.has(`${dir}/${base}`); n++) base = `${stem} ${n}${ext}`;
      files.set(`${dir}/${base}`, "");
      touch(`${dir}/${base}`);
      return base;
    },
    toDisplayUrl: async (absPath) =>
      /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i.test(absPath) ? DEMO_IMAGE : absPath,
    saveDialog: async (defaultName, dir) => {
      const name = window.prompt("Save markdown file as:", defaultName);
      if (!name) return null;
      const base = /\.(md|markdown)$/i.test(name) ? name : `${name}.md`;
      return `${dir ?? "/demo"}/${base}`;
    },
    exportDialog: async (defaultName, dir, ext) => {
      const name = window.prompt(`Export as .${ext}:`, defaultName);
      return name ? `${dir ?? "/demo"}/${name}` : null;
    },
    confirm: async (_title, message) => window.confirm(message),
    confirmChoice: async (_title, message, ok, cancel) =>
      window.confirm(`${message}\n\nOK = ${ok}, Cancel = ${cancel}`),
    renamePath: async (from, to) => {
      if (files.has(to) || dirs.has(to)) throw new Error("already exists");
      relocate(from, to);
      return to;
    },
    moveInto: async (src, destDir) => {
      const base = src.split("/").pop()!;
      const dest = `${destDir}/${base}`;
      if (src.slice(0, src.lastIndexOf("/")) === destDir) return src;
      if (files.has(dest) || dirs.has(dest)) throw new Error("already exists");
      relocate(src, dest);
      return dest;
    },
    createFolder: async (dir, name) => {
      let target = `${dir}/${name}`;
      for (let n = 2; dirs.has(target); n++) target = `${dir}/${name} ${n}`;
      dirs.add(target);
      return target;
    },
    duplicatePath: async (path) => {
      const dot = path.lastIndexOf(".");
      const slash = path.lastIndexOf("/");
      const stem = dot > slash ? path.slice(0, dot) : path;
      const ext = dot > slash ? path.slice(dot) : "";
      let target = `${stem} copy${ext}`;
      for (let n = 2; files.has(target) || dirs.has(target); n++)
        target = `${stem} copy ${n}${ext}`;
      if (files.has(path)) {
        files.set(target, files.get(path)!);
        touch(target);
      } else dirs.add(target);
      return target;
    },
    trashPath: async (path) => {
      if (files.delete(path)) return;
      if (dirs.has(path)) {
        const pref = path + "/";
        dirs.delete(path);
        for (const d of [...dirs]) if (d.startsWith(pref)) dirs.delete(d);
        for (const f of [...files.keys()]) if (f.startsWith(pref)) files.delete(f);
      }
    },
    revealPath: async () => {},
    openPath: async () => {},
    setMenuState: async () => {},
    listAll: async (root) => {
      const pref = root.replace(/\/$/, "") + "/";
      return [...files.keys()]
        .filter((f) => f.startsWith(pref))
        .map((f) => ({ path: f, rel: f.slice(pref.length) }))
        // Lowercase comparison, matching Rust's list_all — the mock is only
        // useful as a stand-in if it orders results the same way.
        .sort((a, b) => a.rel.toLowerCase().localeCompare(b.rel.toLowerCase()));
    },
    searchFiles: async (root, query, opts) => {
      if (!query.trim()) return { hits: [], truncated: false };
      const pref = root.replace(/\/$/, "") + "/";
      let source = opts.regex
        ? query
        : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (opts.wholeWord) source = `\\b(?:${source})\\b`;
      const re = new RegExp(source, opts.caseSensitive ? "" : "i");
      const hits: SearchHit[] = [];
      for (const [path, content] of files) {
        if (!path.startsWith(pref) || !/\.(md|markdown)$/i.test(path)) continue;
        content.split("\n").forEach((text, i) => {
          const m = re.exec(text);
          if (m) {
            // Char (not code-unit) offsets, matching the Rust backend.
            const start = [...text.slice(0, m.index)].length;
            hits.push({
              path,
              rel: path.slice(pref.length),
              line: i + 1,
              text: text.slice(0, 400),
              start,
              end: start + [...m[0]].length,
            });
          }
        });
      }
      return { hits, truncated: false };
    },
    // Fake but realistic, so the git decorations are visible in `npm run dev`.
    gitStatus: async (root) => ({
      root,
      entries: [
        { path: "/demo/README.md", status: "modified" as const },
        { path: "/demo/journal/ideas.md", status: "untracked" as const },
        { path: "/demo/journal/2026-07-23.md", status: "added" as const },
      ].filter((e) => files.has(e.path)),
      truncated: false,
    }),
    gitDiff: async (path) =>
      path.endsWith("README.md")
        ? "--- a/README.md\n+++ b/README.md\n@@ -1,5 +1,6 @@\n # README\n \n-Just a demo file.\n+Just a demo file, edited.\n+A second new line.\n"
        : null,
    gitDiscard: async (path) => {
      files.set(path, "# README\n\nJust a demo file.\n");
      touch(path);
      return "restored";
    },
    // Mirrors the mock gitStatus: only README.md is "in HEAD".
    gitDiscardKind: async (path) =>
      path.endsWith("README.md") ? "restore" : "trash",
    watchFolder: async () => {},
  };

  /** Move a file or a whole directory subtree from oldP to newP (mock only). */
  function relocate(oldP: string, newP: string) {
    if (files.has(oldP)) {
      files.set(newP, files.get(oldP)!);
      files.delete(oldP);
      stamps.set(newP, stamp(oldP));
      return;
    }
    if (dirs.has(oldP)) {
      const pref = oldP + "/";
      dirs.delete(oldP);
      dirs.add(newP);
      for (const d of [...dirs])
        if (d.startsWith(pref)) {
          dirs.delete(d);
          dirs.add(newP + d.slice(oldP.length));
        }
      for (const f of [...files.keys()])
        if (f.startsWith(pref)) {
          const c = files.get(f)!;
          files.delete(f);
          files.set(newP + f.slice(oldP.length), c);
        }
    }
  }
}
