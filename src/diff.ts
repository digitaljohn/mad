// Unified-diff parsing for the changes panel. Pure text in, structure out.

export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface ParsedDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
}

/**
 * Classify one line of unified diff output.
 *
 * Order matters: `+++` and `---` are file headers, not an addition and a
 * deletion. Getting that wrong miscounts every diff by one each way.
 */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (
    /^(\+\+\+|---|diff |index |new file|deleted file|similarity |dissimilarity |rename |copy |old mode|new mode|Binary )/.test(
      line,
    )
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/** Split a unified diff into classified lines with the +/− tally. */
export function parseDiff(text: string): ParsedDiff {
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  // A trailing newline would otherwise render as a stray blank row.
  for (const raw of text.replace(/\n$/, "").split("\n")) {
    const kind = classifyDiffLine(raw);
    if (kind === "add") added++;
    if (kind === "del") removed++;
    lines.push({ kind, text: raw });
  }
  return { lines, added, removed };
}

/** "+3 −1", or "" when there is nothing to report. */
export function diffStat(d: ParsedDiff): string {
  return d.added || d.removed ? `+${d.added} −${d.removed}` : "";
}
