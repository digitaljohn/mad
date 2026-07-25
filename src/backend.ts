// Backend abstraction: real Tauri IPC in the app, an in-memory mock in a
// plain browser (lets the UI be developed/previewed with `npm run dev` alone).

export interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** A file's text plus a change stamp used to detect external edits. */
export interface FileData {
  content: string;
  stamp: string;
}

export interface FileHit {
  path: string;
  rel: string;
}

export interface SearchHit {
  path: string;
  rel: string;
  line: number;
  text: string;
  start: number;
  end: number;
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
}

/** How a file differs from the git index/HEAD. */
export type GitStatus =
  | "modified"
  | "added"
  | "untracked"
  | "deleted"
  | "renamed"
  | "conflict";

export interface GitEntry {
  path: string;
  status: GitStatus;
}

export interface GitInfo {
  root: string;
  entries: GitEntry[];
  truncated: boolean;
}

export interface SearchOptions {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** Thrown/returned by writeFile when the file changed underneath us. */
export const CONFLICT = "__mad_conflict__";

export function isConflict(e: unknown): boolean {
  return String(e).includes(CONFLICT);
}

export interface Backend {
  pickFolder(): Promise<string | null>;
  listDir(path: string): Promise<Entry[]>;
  readFile(path: string): Promise<FileData>;
  /** The file's change stamp alone — cheap enough to poll on watch events. */
  fileStamp(path: string): Promise<string>;
  /** Write `content`. When `expect` is a stamp the write is refused (CONFLICT)
      unless the file still matches it. Resolves to the new stamp. */
  writeFile(path: string, content: string, expect: string | null): Promise<string>;
  createFile(dir: string, name: string): Promise<string>;
  /** Save base64 image data into `dir`; returns the created file name. */
  saveImage(dir: string, name: string, data: string): Promise<string>;
  /** Convert an absolute local path into a URL the webview can display. */
  toDisplayUrl(absPath: string): Promise<string>;
  /** Native Save dialog (markdown only). Returns the chosen path, or null. */
  saveDialog(defaultName: string, dir: string | null): Promise<string | null>;
  /** Native Save dialog for an arbitrary extension (export). */
  exportDialog(
    defaultName: string,
    dir: string | null,
    ext: string,
  ): Promise<string | null>;
  /** Native OK/Cancel confirmation. */
  confirm(title: string, message: string): Promise<boolean>;
  /** Two-choice dialog with custom labels; true = the first button. */
  confirmChoice(
    title: string,
    message: string,
    ok: string,
    cancel: string,
  ): Promise<boolean>;
  /** Single-button information / error dialog. */
  message(title: string, message: string, error: boolean): Promise<void>;
  /** Rename in place (`to` is the full new path). Returns the new path. */
  renamePath(from: string, to: string): Promise<string>;
  /** Move `src` into `destDir`. Returns the new path. */
  moveInto(src: string, destDir: string): Promise<string>;
  /** Create a subfolder (name deduped). Returns the created path. */
  createFolder(dir: string, name: string): Promise<string>;
  /** Copy a file/folder beside itself as "name copy". Returns the new path. */
  duplicatePath(path: string): Promise<string>;
  /** Move a file/folder to the OS Trash. */
  trashPath(path: string): Promise<void>;
  /** Show the item in Finder / the system file manager. */
  revealPath(path: string): Promise<void>;
  /** Open the item in the OS default application. */
  openPath(path: string): Promise<void>;
  /** Enable/disable the native Save / Save As menu items. */
  setMenuState(canSave: boolean, canSaveAs: boolean): Promise<void>;
  /** Every markdown/image file under `root` (for Quick Open). */
  listAll(root: string): Promise<FileHit[]>;
  /** Full-text search across markdown files under `root`. */
  searchFiles(
    root: string,
    query: string,
    opts: SearchOptions,
  ): Promise<SearchResult>;
  /** Pending git changes under `root`; null when it isn't a repository. */
  gitStatus(root: string): Promise<GitInfo | null>;
  /** Start watching `root` for external changes (emits `fs-change`). */
  watchFolder(root: string): Promise<void>;
}

export const isTauri = "__TAURI_INTERNALS__" in window;

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
};

function mimeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

async function tauriBackend(): Promise<Backend> {
  const { invoke } = await import("@tauri-apps/api/core");
  return {
    pickFolder: () => invoke<string | null>("pick_folder"),
    listDir: (path) => invoke<Entry[]>("list_dir", { path }),
    readFile: (path) => invoke<FileData>("read_file", { path }),
    fileStamp: (path) => invoke<string>("file_stamp", { path }),
    writeFile: (path, content, expect) =>
      invoke<string>("write_file", { path, content, expect }),
    createFile: (dir, name) => invoke<string>("create_file", { dir, name }),
    saveImage: (dir, name, data) =>
      invoke<string>("save_image", { dir, name, data }),
    toDisplayUrl: async (absPath) => {
      const b64 = await invoke<string>("read_image", { path: absPath });
      return `data:${mimeOf(absPath)};base64,${b64}`;
    },
    saveDialog: (defaultName, dir) =>
      invoke<string | null>("save_dialog", { defaultName, dir }),
    exportDialog: (defaultName, dir, ext) =>
      invoke<string | null>("export_dialog", { defaultName, dir, ext }),
    confirm: (title, message) => invoke<boolean>("confirm", { title, message }),
    confirmChoice: (title, message, ok, cancel) =>
      invoke<boolean>("confirm_choice", { title, message, ok, cancel }),
    message: (title, message, error) =>
      invoke<void>("message", { title, message, error }),
    renamePath: (from, to) => invoke<string>("rename_path", { from, to }),
    moveInto: (src, destDir) => invoke<string>("move_into", { src, destDir }),
    createFolder: (dir, name) => invoke<string>("create_folder", { dir, name }),
    duplicatePath: (path) => invoke<string>("duplicate_path", { path }),
    trashPath: (path) => invoke<void>("trash_path", { path }),
    revealPath: (path) => invoke<void>("reveal_path", { path }),
    openPath: (path) => invoke<void>("open_path", { path }),
    setMenuState: (canSave, canSaveAs) =>
      invoke<void>("set_menu_state", { canSave, canSaveAs }),
    listAll: (root) => invoke<FileHit[]>("list_all", { root }),
    searchFiles: (root, query, opts) =>
      invoke<SearchResult>("search_files", {
        root,
        query,
        regex: opts.regex,
        caseSensitive: opts.caseSensitive,
        wholeWord: opts.wholeWord,
      }),
    gitStatus: (root) => invoke<GitInfo | null>("git_status", { root }),
    watchFolder: (root) => invoke<void>("watch_folder", { path: root }),
  };
}

// ---------------------------------------------------------------------------
// Browser mock: a small demo workspace so the UI runs outside Tauri.
// ---------------------------------------------------------------------------

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

> Quotes work too. Select text to see the formatting toolbar.

- [x] folder browser
- [x] WYSIWYG editing
- [ ] your notes here
`;

function mockBackend(): Backend {
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
    message: async (title, message) => void window.alert(`${title}\n\n${message}`),
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
        .sort((a, b) => a.rel.localeCompare(b.rel));
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

export async function createBackend(): Promise<Backend> {
  return isTauri ? tauriBackend() : mockBackend();
}
