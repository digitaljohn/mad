import { describe, expect, it } from "vitest";
import { classifyDiffLine, diffStat, parseDiff } from "./diff";

describe("classifyDiffLine", () => {
  it("reads file headers as metadata, not as an add and a delete", () => {
    // The bug this guards: `+++`/`---` start with + and -, so a naive check
    // miscounts every single diff by one in each direction.
    expect(classifyDiffLine("+++ b/README.md")).toBe("meta");
    expect(classifyDiffLine("--- a/README.md")).toBe("meta");
  });

  it("recognises every header git emits", () => {
    for (const line of [
      "diff --git a/a.md b/a.md",
      "index 83db48f..bf269f4 100644",
      "new file mode 100644",
      "deleted file mode 100644",
      "similarity index 95%",
      "dissimilarity index 40%",
      "rename from old.md",
      "copy from old.md",
      "old mode 100644",
      "new mode 100755",
      "Binary files a/p.png and b/p.png differ",
    ]) {
      expect(classifyDiffLine(line), line).toBe("meta");
    }
  });

  it("recognises hunks, additions, deletions and context", () => {
    expect(classifyDiffLine("@@ -1,5 +1,6 @@")).toBe("hunk");
    expect(classifyDiffLine("+added")).toBe("add");
    expect(classifyDiffLine("-removed")).toBe("del");
    expect(classifyDiffLine(" context")).toBe("ctx");
    expect(classifyDiffLine("")).toBe("ctx");
  });

  it("treats a line that is only a plus as an addition", () => {
    expect(classifyDiffLine("+")).toBe("add");
    expect(classifyDiffLine("-")).toBe("del");
  });
});

const SAMPLE = `diff --git a/README.md b/README.md
index 83db48f..bf269f4 100644
--- a/README.md
+++ b/README.md
@@ -1,5 +1,6 @@
 # README

-Just a demo file.
+Just a demo file, edited.
+A second new line.

`;

describe("parseDiff", () => {
  it("counts only real additions and deletions", () => {
    const d = parseDiff(SAMPLE);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
  });

  it("classifies each line and preserves its text", () => {
    const d = parseDiff(SAMPLE);
    expect(d.lines[0]).toEqual({
      kind: "meta",
      text: "diff --git a/README.md b/README.md",
    });
    expect(d.lines[4]).toEqual({ kind: "hunk", text: "@@ -1,5 +1,6 @@" });
    expect(d.lines.find((l) => l.kind === "del")?.text).toBe("-Just a demo file.");
  });

  it("does not emit a blank row for the trailing newline", () => {
    const d = parseDiff("+a\n");
    expect(d.lines).toHaveLength(1);
  });

  it("keeps genuinely blank context lines", () => {
    const d = parseDiff(" a\n\n b\n");
    expect(d.lines.map((l) => l.text)).toEqual([" a", "", " b"]);
  });

  it("handles an empty diff without throwing", () => {
    const d = parseDiff("");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
  });

  it("counts a wholly added file", () => {
    const d = parseDiff("--- /dev/null\n+++ b/new.md\n@@ -0,0 +1,2 @@\n+a\n+b\n");
    expect(d.added).toBe(2);
    expect(d.removed).toBe(0);
  });
});

describe("diffStat", () => {
  it("formats the tally", () => {
    expect(diffStat(parseDiff(SAMPLE))).toBe("+2 −1");
  });

  it("is empty when nothing changed, so the header stays quiet", () => {
    expect(diffStat(parseDiff(" only context\n"))).toBe("");
  });
});
