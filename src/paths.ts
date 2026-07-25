// Path and text helpers shared by the editor, the tree and the app shell.
// Deliberately dependency-free: no DOM, no Tauri, no Milkdown — so it can be
// unit tested directly and imported from anywhere.

/** Files the sidebar displays. Kept in step with Rust's `SHOWN_EXTS`. */
export const IMG_RE = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;
export const MD_RE = /\.(md|markdown)$/i;

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

/** What a link in a document points at. */
export type LinkTarget =
  | { kind: "external"; url: string }
  /** A path on disk — another note, an image, or something for the OS. */
  | { kind: "file"; path: string }
  /** A heading in the document being read. */
  | { kind: "anchor"; id: string }
  | { kind: "ignore" };

const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Work out where a link goes, from the href *as written in the markdown*.
 *
 * It has to be the raw attribute: the DOM resolves `./spec.md` against the
 * webview's own origin, so `anchor.href` reads back as `http://localhost/…`
 * and a relative link to the note next door looks exactly like a link to the
 * open internet. That mistake sent people to their browser instead of to
 * their document.
 */
export function resolveLink(raw: string | null, docPath: string | null): LinkTarget {
  const href = (raw ?? "").trim();
  if (!href) return { kind: "ignore" };
  if (href.startsWith("#")) {
    return { kind: "anchor", id: decodeHref(href.slice(1)) };
  }
  // Any scheme at all — http, mailto, obsidian… — belongs to the OS.
  if (URI_SCHEME.test(href)) return { kind: "external", url: href };

  // A path can't carry a query or fragment; drop them before resolving.
  const bare = decodeHref(href.split(/[?#]/)[0]);
  if (!bare) return { kind: "ignore" };
  if (bare.startsWith("/")) return { kind: "file", path: normalize(bare) };
  // Relative links are relative to the document holding them, so an unsaved
  // draft has nothing to resolve against.
  if (!docPath) return { kind: "ignore" };
  return { kind: "file", path: normalize(`${dirOf(docPath)}/${bare}`) };
}

/** Markdown writers escape spaces as %20; a malformed escape is literal. */
function decodeHref(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
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
