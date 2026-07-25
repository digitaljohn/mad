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
  /** Enable/disable the state-gated native menu items: `doc` = an active
      markdown document, `tab` = any open tab, `folder` = an open workspace. */
  setMenuState(doc: boolean, tab: boolean, folder: boolean): Promise<void>;
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
  /** Unified diff for one file against the last commit; null if unchanged. */
  gitDiff(path: string): Promise<string | null>;
  /** Throw away a file's changes. Resolves "restored" or "trashed". */
  gitDiscard(path: string): Promise<string>;
  /** What gitDiscard would do: "restore" (back to HEAD) or "trash" (nothing
      committed to go back to). Lets the UI promise only what will happen. */
  gitDiscardKind(path: string): Promise<string>;
  /** Start watching `root` for external changes (emits `fs-change`). */
  watchFolder(root: string): Promise<void>;
}

export const isTauri = "__TAURI_INTERNALS__" in window;

/** Quick Open result cap — kept in step with `MAX_LISTED` in lib.rs. An index
    of exactly this size is truncated and must not be treated as exhaustive. */
export const LIST_CAP = 20_000;

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
    renamePath: (from, to) => invoke<string>("rename_path", { from, to }),
    moveInto: (src, destDir) => invoke<string>("move_into", { src, destDir }),
    createFolder: (dir, name) => invoke<string>("create_folder", { dir, name }),
    duplicatePath: (path) => invoke<string>("duplicate_path", { path }),
    trashPath: (path) => invoke<void>("trash_path", { path }),
    revealPath: (path) => invoke<void>("reveal_path", { path }),
    openPath: (path) => invoke<void>("open_path", { path }),
    setMenuState: (doc, tab, folder) =>
      invoke<void>("set_menu_state", { doc, tab, folder }),
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
    gitDiff: (path) => invoke<string | null>("git_diff", { path }),
    gitDiscard: (path) => invoke<string>("git_discard", { path }),
    gitDiscardKind: (path) => invoke<string>("git_discard_kind", { path }),
    watchFolder: (root) => invoke<void>("watch_folder", { path: root }),
  };
}

export async function createBackend(): Promise<Backend> {
  if (isTauri) return tauriBackend();
  // Loaded lazily so the app bundle never parses the demo workspace.
  const { mockBackend } = await import("./backend.mock");
  return mockBackend();
}
