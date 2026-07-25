// Path and text helpers shared by the editor, the tree and the app shell.
// Deliberately dependency-free: no DOM, no Tauri, no Milkdown — so it can be
// unit tested directly and imported from anywhere.

/** Files the sidebar displays. Kept in step with Rust's `SHOWN_EXTS`. */
export const IMG_RE = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;
export const MD_RE = /\.(md|markdown)$/i;

export const isImage = (path: string) => IMG_RE.test(path);
export const isMarkdown = (path: string) => MD_RE.test(path);

/** Everything before the last separator. `""` for a bare name. */
export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? (i === 0 ? "/" : "") : path.slice(0, i);
}

/** The final segment. Returns the input when there is no separator. */
export function baseOf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/** The final segment without a markdown extension — what tabs and rows show. */
export function displayName(path: string): string {
  return baseOf(path).replace(MD_RE, "");
}

/** Collapse `.` and `..` segments of an absolute POSIX path. */
export function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

/** Directory containing `path`; `/` when it sits at the root. */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}

/** Relative path from `fromDir` to `target` (both absolute POSIX paths). */
export function relativize(fromDir: string, target: string): string {
  const from = fromDir.split("/").filter(Boolean);
  const to = target.split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  return [...Array(from.length - i).fill(".."), ...to.slice(i)].join("/");
}

/** True when `child` is `parent` itself or sits underneath it. */
export function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + "/");
}

/** Rewrite `path` for a move of `from` → `to`, leaving unrelated paths alone. */
export function remapPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(from + "/")) return to + path.slice(from.length);
  return path;
}

/** Escape a string for literal use inside a RegExp. */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Escape for interpolation into HTML — text *or* attribute context. */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

/**
 * Exactly one trailing newline, the way every other text editor writes files.
 * ProseMirror keeps a trailing empty paragraph that would otherwise add a blank
 * line on the first save of every document.
 */
export function normalizeTrailer(md: string): string {
  return md.trim() ? md.replace(/\n+$/, "") + "\n" : "";
}

/**
 * Words, for the status bar. `don't` and `re-use` count as one each.
 *
 * A word has to *start* with a letter or digit, otherwise markdown punctuation
 * counts as prose: `---` is a thematic break, not a word, and a `-` bullet
 * marker isn't one either.
 */
export function countWords(text: string): number {
  if (!text.trim()) return 0;
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}

/** Whole minutes at ~220wpm, minimum 1 for a non-empty document. */
export function readingMinutes(words: number): number {
  return words ? Math.max(1, Math.round(words / 220)) : 0;
}
