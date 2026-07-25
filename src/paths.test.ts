import { describe, expect, it } from "vitest";
import {
  resolveLink,
  baseOf,
  countWords,
  dirOf,
  displayName,
  escapeHtml,
  escapeRe,
  IMG_RE,
  isUnder,
  MD_RE,
  normalize,
  normalizeTrailer,
  parentOf,
  readingMinutes,
  relativize,
  remapPath,
} from "./paths";

describe("file type tests", () => {
  it("recognises markdown and images case-insensitively", () => {
    expect(MD_RE.test("a.md")).toBe(true);
    expect(MD_RE.test("a.MARKDOWN")).toBe(true);
    expect(MD_RE.test("a.mdx")).toBe(false);
    expect(MD_RE.test("md")).toBe(false);
    expect(IMG_RE.test("p.PNG")).toBe(true);
    expect(IMG_RE.test("p.jpeg")).toBe(true);
    expect(IMG_RE.test("p.svg")).toBe(true);
    expect(IMG_RE.test("p.psd")).toBe(false);
  });

  it("does not mistake an extension inside the name for the extension", () => {
    expect(MD_RE.test("notes.md.bak")).toBe(false);
    expect(IMG_RE.test("png.txt")).toBe(false);
  });
});

describe("parentOf", () => {
  it("returns the containing directory", () => {
    expect(parentOf("/a/b/c.md")).toBe("/a/b");
    expect(parentOf("a/b.md")).toBe("a");
  });

  it("handles the filesystem root without eating the slash", () => {
    expect(parentOf("/c.md")).toBe("/");
  });

  it("returns empty for a bare name", () => {
    expect(parentOf("c.md")).toBe("");
  });
});

describe("baseOf and displayName", () => {
  it("takes the final segment", () => {
    expect(baseOf("/a/b/c.md")).toBe("c.md");
    expect(baseOf("c.md")).toBe("c.md");
  });

  it("survives a trailing slash rather than returning empty", () => {
    expect(baseOf("/a/b/")).toBe("/a/b/");
  });

  it("strips only markdown extensions for display", () => {
    expect(displayName("/a/spec.md")).toBe("spec");
    expect(displayName("/a/spec.markdown")).toBe("spec");
    expect(displayName("/a/diagram.png")).toBe("diagram.png");
  });
});

describe("normalize", () => {
  it("collapses . and .. segments", () => {
    expect(normalize("/a/b/../c.md")).toBe("/a/c.md");
    expect(normalize("/a/./b.md")).toBe("/a/b.md");
    expect(normalize("/a//b.md")).toBe("/a/b.md");
  });

  it("cannot be walked above the root", () => {
    expect(normalize("/../../etc/passwd")).toBe("/etc/passwd");
  });
});

describe("dirOf", () => {
  it("returns the directory, or / at the top", () => {
    expect(dirOf("/a/b/c.md")).toBe("/a/b");
    expect(dirOf("/c.md")).toBe("/");
  });
});

describe("relativize", () => {
  it("builds a relative link between sibling files", () => {
    expect(relativize("/w/docs", "/w/docs/pic.png")).toBe("pic.png");
  });

  it("walks up as far as needed", () => {
    expect(relativize("/w/docs/deep", "/w/assets/pic.png")).toBe(
      "../../assets/pic.png",
    );
  });

  it("round-trips with normalize", () => {
    const from = "/w/a/b";
    const target = "/w/x/y/pic.png";
    expect(normalize(from + "/" + relativize(from, target))).toBe(target);
  });
});

describe("isUnder", () => {
  it("counts the path itself", () => {
    expect(isUnder("/a/b", "/a/b")).toBe(true);
  });

  it("counts descendants", () => {
    expect(isUnder("/a/b/c.md", "/a/b")).toBe(true);
  });

  it("does not match a sibling with a shared prefix", () => {
    expect(isUnder("/a/bc.md", "/a/b")).toBe(false);
  });
});

describe("remapPath", () => {
  it("rewrites the moved path and its descendants", () => {
    expect(remapPath("/a/old", "/a/old", "/a/new")).toBe("/a/new");
    expect(remapPath("/a/old/x.md", "/a/old", "/a/new")).toBe("/a/new/x.md");
  });

  it("leaves a sibling with a shared prefix alone", () => {
    expect(remapPath("/a/oldish.md", "/a/old", "/a/new")).toBe("/a/oldish.md");
  });
});

describe("escaping", () => {
  it("escapes regex metacharacters so a search is literal", () => {
    const re = new RegExp(escapeRe("a.b*c"));
    expect(re.test("a.b*c")).toBe(true);
    expect(re.test("axbbc")).toBe(false);
  });

  it("escapes everything that breaks HTML text or attributes", () => {
    // Quotes matter too: a filename containing " must survive a future move
    // of this output into an attribute context.
    expect(escapeHtml("<b>&\"'")).toBe("&lt;b&gt;&amp;&quot;&#39;");
  });
});

describe("normalizeTrailer", () => {
  it("leaves exactly one trailing newline", () => {
    expect(normalizeTrailer("a\n\n\n")).toBe("a\n");
    expect(normalizeTrailer("a")).toBe("a\n");
    expect(normalizeTrailer("a\n")).toBe("a\n");
  });

  it("keeps whitespace-only documents empty", () => {
    expect(normalizeTrailer("")).toBe("");
    expect(normalizeTrailer("\n\n  \n")).toBe("");
  });

  it("is idempotent, so re-saving does not keep changing the file", () => {
    const once = normalizeTrailer("# T\n\n- a\n\n\n");
    expect(normalizeTrailer(once)).toBe(once);
  });

  it("does not disturb interior blank lines", () => {
    expect(normalizeTrailer("a\n\nb\n")).toBe("a\n\nb\n");
  });
});

describe("countWords", () => {
  it("counts words, not whitespace runs", () => {
    expect(countWords("one two  three")).toBe(3);
    expect(countWords("")).toBe(0);
    expect(countWords("   \n ")).toBe(0);
  });

  it("treats apostrophes and hyphens as part of a word", () => {
    expect(countWords("don't re-use it")).toBe(3);
    expect(countWords("don’t")).toBe(1);
  });

  it("ignores markdown punctuation that isn't prose", () => {
    // A thematic break and a bullet marker are not words.
    expect(countWords("# Title\n\n---\n\n- one\n- two\n")).toBe(3);
  });

  it("counts non-Latin scripts", () => {
    expect(countWords("café über naïve")).toBe(3);
  });

  it("does not count punctuation as a word", () => {
    expect(countWords("hi — there")).toBe(2);
  });

  it("is zero for text made entirely of punctuation", () => {
    // Non-blank, so the early return doesn't fire, but nothing matches — the
    // regex returns null and the count has to fall back to zero.
    expect(countWords("---")).toBe(0);
    expect(countWords("*** !!! ***")).toBe(0);
  });
});

describe("readingMinutes", () => {
  it("is zero only for an empty document", () => {
    expect(readingMinutes(0)).toBe(0);
    expect(readingMinutes(1)).toBe(1);
  });

  it("rounds to the nearest minute at ~220wpm", () => {
    expect(readingMinutes(220)).toBe(1);
    expect(readingMinutes(700)).toBe(3);
  });
});

describe("resolveLink", () => {
  const doc = "/w/docs/guide.md";

  it("opens a relative note in mad, not the browser", () => {
    // The bug: the DOM resolves "./spec.md" against the webview origin, so
    // a.href reads "http://localhost/spec.md" and a link to the note next
    // door was indistinguishable from a link to the open internet.
    expect(resolveLink("./spec.md", doc)).toEqual({
      kind: "file",
      path: "/w/docs/spec.md",
    });
    expect(resolveLink("spec.md", doc)).toEqual({
      kind: "file",
      path: "/w/docs/spec.md",
    });
  });

  it("climbs out of the current folder", () => {
    expect(resolveLink("../notes/todo.md", doc)).toEqual({
      kind: "file",
      path: "/w/notes/todo.md",
    });
  });

  it("takes an absolute path as written", () => {
    expect(resolveLink("/other/a.md", doc)).toEqual({
      kind: "file",
      path: "/other/a.md",
    });
  });

  it("sends anything with a scheme to the OS", () => {
    for (const url of [
      "https://example.com/x",
      "http://example.com",
      "mailto:someone@example.com",
      "HTTPS://EXAMPLE.COM",
    ]) {
      expect(resolveLink(url, doc)).toEqual({ kind: "external", url });
    }
  });

  it("treats a bare fragment as a heading in this document", () => {
    expect(resolveLink("#some-heading", doc)).toEqual({
      kind: "anchor",
      id: "some-heading",
    });
  });

  it("drops a query or fragment hanging off a file link", () => {
    expect(resolveLink("spec.md#section", doc)).toEqual({
      kind: "file",
      path: "/w/docs/spec.md",
    });
    expect(resolveLink("spec.md?v=2", doc)).toEqual({
      kind: "file",
      path: "/w/docs/spec.md",
    });
  });

  it("decodes escaped spaces, which is how writers link such files", () => {
    expect(resolveLink("my%20notes.md", doc)).toEqual({
      kind: "file",
      path: "/w/docs/my notes.md",
    });
  });

  it("leaves a malformed escape alone rather than throwing", () => {
    expect(() => resolveLink("100%.md", doc)).not.toThrow();
    expect(resolveLink("100%.md", doc)).toEqual({
      kind: "file",
      path: "/w/docs/100%.md",
    });
  });

  it("ignores a relative link with no document to resolve against", () => {
    // An unsaved draft has no folder, so "./spec.md" means nothing yet.
    expect(resolveLink("./spec.md", null)).toEqual({ kind: "ignore" });
  });

  it("ignores empty and missing hrefs", () => {
    expect(resolveLink("", doc)).toEqual({ kind: "ignore" });
    expect(resolveLink(null, doc)).toEqual({ kind: "ignore" });
    expect(resolveLink("   ", doc)).toEqual({ kind: "ignore" });
    expect(resolveLink("#", doc)).toEqual({ kind: "anchor", id: "" });
  });
});
