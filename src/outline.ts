// Headings: GitHub-compatible slugs, a source-text outline scanner, and the
// sidebar outline panel's renderer. The slug algorithm is shared by the rich
// editor's heading ids, the outline panel and workspace heading search, so a
// link that works on GitHub finds the same heading here.

export interface HeadingRef {
  text: string;
  level: number;
  /** Slug for the rich editor (`scrollToHeading`). */
  id: string;
  /** 1-based source line, when the outline came from raw text. */
  line?: number;
}

/**
 * GitHub's anchor slug, close enough to round-trip: lowercase, punctuation
 * dropped, spaces to hyphens — `Foo: Bar!` → `foo-bar`, matching what
 * github.com generates for the same heading. (Duplicate-heading `-1`
 * suffixes are a document-level concern and are handled by the caller when
 * it can see the whole document.)
 */
export function githubSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

/** `## Title` → `{ level: 2, text: "Title" }`; null for anything else. */
export function parseHeadingLine(line: string): { level: number; text: string } | null {
  const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line.trim());
  if (!m || !m[2]) return null;
  return { level: m[1].length, text: m[2] };
}

/**
 * Headings of a raw markdown text, for outline duty while the source editor
 * is the active surface. Skips fenced code blocks so a `# comment` inside
 * ```bash doesn't masquerade as a chapter.
 */
export function sourceOutline(text: string): HeadingRef[] {
  const out: HeadingRef[] = [];
  let fence: string | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0].repeat(3);
      else if (f[1].startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;
    const h = parseHeadingLine(line);
    if (h) out.push({ ...h, id: githubSlug(h.text), line: i + 1 });
  }
  return out;
}

/**
 * Render the outline panel's list. Returns the number of rows painted so the
 * caller can decide whether the panel is worth showing at all.
 */
export function renderOutline(
  container: HTMLElement,
  items: HeadingRef[],
  onPick: (item: HeadingRef) => void,
): number {
  container.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "outline-empty";
    empty.textContent = "No headings";
    container.appendChild(empty);
    return 0;
  }
  const min = Math.min(...items.map((h) => h.level));
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "outline-item";
    row.setAttribute("role", "link");
    row.tabIndex = 0;
    row.style.setProperty("--outline-indent", String(item.level - min));
    row.textContent = item.text || "(untitled heading)";
    row.title = item.text;
    row.addEventListener("click", () => onPick(item));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onPick(item);
      }
    });
    container.appendChild(row);
  }
  return items.length;
}
