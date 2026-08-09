import { describe, expect, it } from "vitest";
import { joinFrontmatter, restoreEscapes, splitFrontmatter } from "./roundtrip";

describe("splitFrontmatter", () => {
  it("splits a conventional block and keeps every byte", () => {
    const text = "---\ntitle: Spec\ndate: 2026-01-01\n---\n\n# Hello\n";
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter).toBe("---\ntitle: Spec\ndate: 2026-01-01\n---\n\n");
    expect(body).toBe("# Hello\n");
    expect(frontmatter + body).toBe(text);
  });

  it("absorbs every blank line after the fence into the prefix", () => {
    // The rich editor drops leading blank lines, so they must not be body.
    const text = "---\na: 1\n---\n\n\n\nBody\n";
    const { frontmatter, body } = splitFrontmatter(text);
    expect(body).toBe("Body\n");
    expect(frontmatter + body).toBe(text);
  });

  it("supports the YAML `...` terminator", () => {
    const { frontmatter, body } = splitFrontmatter("---\na: 1\n...\nBody\n");
    expect(frontmatter).toBe("---\na: 1\n...\n");
    expect(body).toBe("Body\n");
  });

  it("keeps CRLF documents byte-identical", () => {
    const text = "---\r\ntitle: x\r\n---\r\nBody\r\n";
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter + body).toBe(text);
    expect(body).toBe("Body\r\n");
  });

  it("handles a document that is only front matter", () => {
    const text = "---\ntitle: x\n---\n";
    expect(splitFrontmatter(text)).toEqual({ frontmatter: text, body: "" });
  });

  it("handles an unclosed fence as body — that's a thematic break", () => {
    const text = "---\nnot yaml, just prose\n";
    expect(splitFrontmatter(text)).toEqual({ frontmatter: "", body: text });
  });

  it("requires the fence on the very first line", () => {
    for (const text of ["\n---\na: 1\n---\n", "# Title\n---\na: 1\n---\n", " ---\na: 1\n---\n"]) {
      expect(splitFrontmatter(text).frontmatter).toBe("");
    }
  });

  it("does not mistake a longer dash run for a fence", () => {
    const text = "----\nnot front matter\n----\n";
    expect(splitFrontmatter(text).frontmatter).toBe("");
  });

  it("accepts an empty metadata block", () => {
    const { frontmatter, body } = splitFrontmatter("---\n---\nBody\n");
    expect(frontmatter).toBe("---\n---\n");
    expect(body).toBe("Body\n");
  });

  it("leaves ordinary documents untouched", () => {
    for (const text of ["", "# Hi\n", "plain prose\n"]) {
      expect(splitFrontmatter(text)).toEqual({ frontmatter: "", body: text });
    }
  });

  it("tolerates trailing spaces on the fence lines", () => {
    const text = "---  \na: 1\n--- \nBody\n";
    const { frontmatter, body } = splitFrontmatter(text);
    expect(body).toBe("Body\n");
    expect(frontmatter + body).toBe(text);
  });
});

describe("restoreEscapes", () => {
  it("unescapes wikilinks, embeds included", () => {
    expect(restoreEscapes("See \\[\\[Page Name]] and !\\[\\[img.png]].")).toBe(
      "See [[Page Name]] and ![[img.png]].",
    );
    expect(restoreEscapes("\\[\\[a|alias]]")).toBe("[[a|alias]]");
  });

  it("leaves a lone escaped bracket alone — the user may have typed it", () => {
    expect(restoreEscapes("a \\[literal] bracket")).toBe("a \\[literal] bracket");
    // Escaped double brackets with no closing pair stay escaped too.
    expect(restoreEscapes("\\[\\[ dangling")).toBe("\\[\\[ dangling");
  });

  it("unescapes GitHub alert markers inside blockquotes", () => {
    expect(restoreEscapes("> \\[!NOTE]\n> Useful info.")).toBe(
      "> [!NOTE]\n> Useful info.",
    );
    expect(restoreEscapes(">\\[!WARNING]\n> Careful.")).toBe(
      ">[!WARNING]\n> Careful.",
    );
    // Nested quote.
    expect(restoreEscapes("> > \\[!TIP]")).toBe("> > [!TIP]");
  });

  it("only recognizes GitHub's five alert kinds", () => {
    expect(restoreEscapes("> \\[!SHOUTING]")).toBe("> \\[!SHOUTING]");
  });

  it("does not touch an alert-looking marker outside a quote", () => {
    expect(restoreEscapes("\\[!NOTE] in prose")).toBe("\\[!NOTE] in prose");
  });

  it("unescapes [toc] on its own line only", () => {
    expect(restoreEscapes("\\[toc]\n\n# A")).toBe("[toc]\n\n# A");
    expect(restoreEscapes("\\[TOC]")).toBe("[TOC]");
    expect(restoreEscapes("about \\[toc] inline")).toBe("about \\[toc] inline");
  });

  it("is a fixpoint — running it twice changes nothing more", () => {
    const once = restoreEscapes("\\[\\[a]] > \\[!NOTE]\n\\[toc]");
    expect(restoreEscapes(once)).toBe(once);
  });

  it("never touches fenced code — a wikilink regex keeps its backslashes", () => {
    const md =
      "before\n\n```js\nconst wiki = /\\[\\[([^\\]]+)\\]\\]/g;\n```\n\nafter \\[\\[Real]]";
    expect(restoreEscapes(md)).toBe(
      "before\n\n```js\nconst wiki = /\\[\\[([^\\]]+)\\]\\]/g;\n```\n\nafter [[Real]]",
    );
  });

  it("never touches alert or toc lookalikes inside a fence", () => {
    const md = "```md\n> \\[!NOTE]\n\\[toc]\n```\n";
    expect(restoreEscapes(md)).toBe(md);
  });

  it("never touches inline code", () => {
    expect(restoreEscapes("see `\\[\\[x]]` but \\[\\[y]] works")).toBe(
      "see `\\[\\[x]]` but [[y]] works",
    );
    // Longer backtick runs delimit too.
    expect(restoreEscapes("``a ` b \\[\\[x]]`` end")).toBe("``a ` b \\[\\[x]]`` end");
  });

  it("keeps an unclosed fence protected to the end of the document", () => {
    const md = "```\n\\[\\[swallowed]]\n";
    expect(restoreEscapes(md)).toBe(md);
  });

  it("requires the closing fence to match char and length", () => {
    const md = "````\n```\n\\[\\[still code]]\n````\n\\[\\[out]]";
    expect(restoreEscapes(md)).toBe("````\n```\n\\[\\[still code]]\n````\n[[out]]");
  });

  it("does not treat text after an inline span as a line start", () => {
    // The slice after `x` begins mid-line: the line-anchored [toc] rule
    // must not fire there, but a later real line still unescapes.
    expect(restoreEscapes("`x`\\[toc]\n\\[toc]")).toBe("`x`\\[toc]\n[toc]");
  });

  it("handles tilde fences like backtick fences", () => {
    const md = "~~~\n\\[\\[x]]\n~~~\n\\[\\[y]]";
    expect(restoreEscapes(md)).toBe("~~~\n\\[\\[x]]\n~~~\n[[y]]");
  });
});

describe("joinFrontmatter", () => {
  it("concatenates verbatim when the prefix ends in a newline", () => {
    expect(joinFrontmatter("---\na: 1\n---\n", "body\n")).toBe(
      "---\na: 1\n---\nbody\n",
    );
  });

  it("restores the newline a fence cut at end-of-file lacks", () => {
    // A metadata stub with no trailing newline must not get body glued
    // onto its closing fence.
    expect(joinFrontmatter("---\na: 1\n---", "hello\n")).toBe(
      "---\na: 1\n---\nhello\n",
    );
  });

  it("adds nothing while the body is empty — byte-exact round trip", () => {
    expect(joinFrontmatter("---\na: 1\n---", "")).toBe("---\na: 1\n---");
    expect(joinFrontmatter("", "body\n")).toBe("body\n");
    expect(joinFrontmatter("", "")).toBe("");
  });
});
