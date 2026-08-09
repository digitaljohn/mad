// Byte-fidelity helpers for the rich editor's round trip.
//
// The editor's contract is that saving a document changes only what the user
// edited. Milkdown's remark pipeline breaks that promise for syntax it does
// not model: YAML front matter parses as a thematic break plus a setext
// heading, and serializing escapes the leading brackets of wikilinks, GitHub
// alerts and `[toc]` macros. These helpers carry such constructs *around* the
// rich editor instead of through it.
//
// Dependency-free on purpose — see paths.ts for the reasoning.

/** A document split into an untouchable prefix and the editable remainder. */
export interface FrontmatterSplit {
  /** The `---` block plus any blank lines after it, byte-exact; `""` if none. */
  frontmatter: string;
  body: string;
}

/**
 * Split leading YAML front matter off `text`.
 *
 * Only the universal convention counts: the *first line* of the file is
 * exactly `---`, and a later line is exactly `---` (or YAML's `...`).
 * Anything else — including a `---` mid-document, which is a thematic
 * break — is body. Blank lines directly after the closing fence belong to
 * the prefix, so re-joining `frontmatter + body` reproduces the original
 * bytes even after the editor normalizes leading blank lines away.
 */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const none = { frontmatter: "", body: text };
  const first = text.match(/^---[ \t]*\r?\n/);
  if (!first) return none;
  const fenceEnd = first[0].length;
  // The closing fence is a line of its own: `---` or `...`.
  const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;
  const rest = text.slice(fenceEnd);
  const m = close.exec(rest);
  if (!m) return none;
  let end = fenceEnd + m.index + m[0].length;
  // Blank lines after the fence travel with the prefix — the rich editor
  // would otherwise swallow them and re-joining would lose bytes.
  const blanks = /^(?:[ \t]*\r?\n)+/.exec(text.slice(end));
  if (blanks) end += blanks[0].length;
  return { frontmatter: text.slice(0, end), body: text.slice(end) };
}

/** Re-join a split document, restoring the newline a fence cut at EOF lacks.
    Without it, a file ending exactly on `---` would get body text glued onto
    the closing fence. */
export function joinFrontmatter(frontmatter: string, body: string): string {
  if (!frontmatter || !body || frontmatter.endsWith("\n")) {
    return frontmatter + body;
  }
  return frontmatter + "\n" + body;
}

/** Inline code spans: a backtick run, anything, the same run. */
const INLINE_CODE = /(`+)(?!`)[\s\S]*?\1(?!`)/g;

/**
 * Apply `fn` to every stretch of `md` that is not code. Fenced blocks are
 * detected line by line (the same rules the serializer emits: a run of
 * ``` or ~~~ up to three spaces deep, closed by at least as long a run of
 * the same character); inline code spans are matched within what remains.
 * Code content must come back byte-identical — that is the whole point.
 */
function mapOutsideCode(
  md: string,
  fn: (text: string, atLineStart: boolean) => string,
): string {
  const out: string[] = [];
  const lines = md.split("\n");
  let text: string[] = [];
  let code: string[] = [];
  let fence: { char: string; len: number } | null = null;
  const flushText = () => {
    if (!text.length) return;
    // Protect inline code spans inside the non-fenced stretch. `fn` is told
    // whether its slice begins at a line start, because a slice that begins
    // right after a closing backtick must not satisfy `^`-anchored patterns.
    const joined = text.join("\n");
    let cursor = 0;
    let result = "";
    for (const m of joined.matchAll(INLINE_CODE)) {
      const atLineStart = cursor === 0 || joined[cursor - 1] === "\n";
      result += fn(joined.slice(cursor, m.index), atLineStart) + m[0];
      cursor = m.index + m[0].length;
    }
    const atLineStart = cursor === 0 || joined[cursor - 1] === "\n";
    result += fn(joined.slice(cursor), atLineStart);
    out.push(result);
    text = [];
  };
  for (const line of lines) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      code.push(line);
      if (f && f[1][0] === fence.char && f[1].length >= fence.len) {
        out.push(code.join("\n"));
        code = [];
        fence = null;
      }
      continue;
    }
    if (f) {
      flushText();
      fence = { char: f[1][0], len: f[1].length };
      code.push(line);
      continue;
    }
    text.push(line);
  }
  flushText();
  if (code.length) out.push(code.join("\n")); // unclosed fence runs to EOF
  return out.join("\n");
}

/**
 * Undo the escapes remark-stringify adds to constructs it cannot know are
 * syntax: wikilinks, GitHub alert markers and `[toc]`. Each pattern is
 * matched exactly so ordinary escaped brackets the user typed stay escaped,
 * and code — fenced or inline — is never touched: a code block documenting
 * a wikilink regex must keep its backslashes.
 *
 * These constructs render as plain text in the rich editor either way; this
 * only guarantees the *bytes* survive an unrelated edit elsewhere in the
 * document.
 */
export function restoreEscapes(md: string): string {
  // `> [!NOTE]` … `> [!CAUTION]` — GitHub alerts, only at quote start —
  // and `[toc]` on a line of its own, Typora's table-of-contents macro.
  const anchored = (s: string) =>
    s
      .replace(
        /^(\s{0,3}(?:>\s*)+)\\\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gm,
        "$1[!$2]",
      )
      .replace(/^\\(\[(?:toc|TOC)\])[ \t]*$/gm, "$1");
  return mapOutsideCode(md, (text, atLineStart) => {
    let s = text;
    if (atLineStart) {
      s = anchored(s);
    } else {
      // The slice starts mid-line (after an inline code span): its first
      // line must not be treated as a line start.
      const nl = s.indexOf("\n");
      if (nl >= 0) s = s.slice(0, nl + 1) + anchored(s.slice(nl + 1));
    }
    // `[[Page]]` and `![[embed.png]]` — Obsidian-style wikilinks.
    return s.replace(/\\\[\\?\[(?=[^\n]*\]\])/g, "[[");
  });
}
