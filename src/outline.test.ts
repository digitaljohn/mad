import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  githubSlug,
  parseHeadingLine,
  renderOutline,
  sourceOutline,
  type HeadingRef,
} from "./outline";

describe("githubSlug", () => {
  it("matches GitHub for plain headings", () => {
    expect(githubSlug("Getting Started")).toBe("getting-started");
  });

  it("drops punctuation the way github.com does", () => {
    expect(githubSlug("Foo: Bar!")).toBe("foo-bar");
    expect(githubSlug("What's new?")).toBe("whats-new");
    expect(githubSlug("C++ (notes)")).toBe("c-notes");
  });

  it("keeps underscores and hyphens", () => {
    expect(githubSlug("snake_case and kebab-case")).toBe(
      "snake_case-and-kebab-case",
    );
  });

  it("keeps unicode letters", () => {
    expect(githubSlug("Überblick")).toBe("überblick");
  });

  it("collapses runs of whitespace to one hyphen", () => {
    expect(githubSlug("a   b\tc")).toBe("a-b-c");
  });

  it("returns empty for a heading of pure punctuation", () => {
    expect(githubSlug("!!!")).toBe("");
  });
});

describe("parseHeadingLine", () => {
  it("parses each level", () => {
    expect(parseHeadingLine("# One")).toEqual({ level: 1, text: "One" });
    expect(parseHeadingLine("###### Six")).toEqual({ level: 6, text: "Six" });
  });

  it("strips closing hashes, the optional ATX suffix", () => {
    expect(parseHeadingLine("## Two ##")).toEqual({ level: 2, text: "Two" });
  });

  it("rejects non-headings", () => {
    for (const line of ["", "prose", "####### seven", "#nospace", "  - # in a list? no"]) {
      expect(parseHeadingLine(line)).toBeNull();
    }
  });

  it("rejects an empty heading", () => {
    expect(parseHeadingLine("## ")).toBeNull();
  });
});

describe("sourceOutline", () => {
  it("collects headings with 1-based line numbers and slugs", () => {
    const md = "# Title\n\ntext\n\n## Section A\n### Sub: part!\n";
    expect(sourceOutline(md)).toEqual([
      { text: "Title", level: 1, id: "title", line: 1 },
      { text: "Section A", level: 2, id: "section-a", line: 5 },
      { text: "Sub: part!", level: 3, id: "sub-part", line: 6 },
    ]);
  });

  it("ignores headings inside fenced code blocks", () => {
    const md = "```bash\n# a comment\n```\n# Real\n~~~\n# also code\n~~~\n";
    expect(sourceOutline(md).map((h) => h.text)).toEqual(["Real"]);
  });

  it("handles a fence that never closes", () => {
    const md = "```\n# swallowed\n";
    expect(sourceOutline(md)).toEqual([]);
  });

  it("requires the closing fence to match the opening character", () => {
    const md = "```\n~~~\n# still code\n```\n# out\n";
    expect(sourceOutline(md).map((h) => h.text)).toEqual(["out"]);
  });

  it("returns nothing for prose without headings", () => {
    expect(sourceOutline("just\nwords\n")).toEqual([]);
  });
});

describe("renderOutline", () => {
  let host: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    host = document.getElementById("host")!;
  });

  const items: HeadingRef[] = [
    { text: "Top", level: 2, id: "top" },
    { text: "Inner", level: 3, id: "inner" },
  ];

  it("renders one focusable row per heading and reports the count", () => {
    const n = renderOutline(host, items, () => {});
    expect(n).toBe(2);
    const rows = [...host.querySelectorAll<HTMLElement>(".outline-item")];
    expect(rows.map((r) => r.textContent)).toEqual(["Top", "Inner"]);
    expect(rows.every((r) => r.tabIndex === 0)).toBe(true);
  });

  it("indents relative to the shallowest heading present", () => {
    renderOutline(host, items, () => {});
    const rows = [...host.querySelectorAll<HTMLElement>(".outline-item")];
    expect(rows[0].style.getPropertyValue("--outline-indent")).toBe("0");
    expect(rows[1].style.getPropertyValue("--outline-indent")).toBe("1");
  });

  it("invokes the pick callback on click and on Enter", () => {
    const onPick = vi.fn();
    renderOutline(host, items, onPick);
    const rows = [...host.querySelectorAll<HTMLElement>(".outline-item")];
    rows[0].click();
    expect(onPick).toHaveBeenLastCalledWith(items[0]);
    rows[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onPick).toHaveBeenLastCalledWith(items[1]);
    rows[1].dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(onPick).toHaveBeenCalledTimes(3);
  });

  it("ignores other keys", () => {
    const onPick = vi.fn();
    renderOutline(host, items, onPick);
    host
      .querySelector<HTMLElement>(".outline-item")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("labels an untitled heading", () => {
    renderOutline(host, [{ text: "", level: 1, id: "" }], () => {});
    expect(host.querySelector(".outline-item")!.textContent).toBe(
      "(untitled heading)",
    );
  });

  it("shows an empty state and clears previous rows", () => {
    renderOutline(host, items, () => {});
    const n = renderOutline(host, [], () => {});
    expect(n).toBe(0);
    expect(host.querySelectorAll(".outline-item")).toHaveLength(0);
    expect(host.querySelector(".outline-empty")!.textContent).toBe("No headings");
  });
});
