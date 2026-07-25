import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CommandPalette,
  ICON_COMMAND,
  ICON_HEADING,
  type PaletteItem,
} from "./palette";

const item = (title: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({
  title,
  run: vi.fn(),
  ...extra,
});

const rows = () => [...document.querySelectorAll<HTMLElement>(".palette-item")];
const titles = () =>
  rows().map((r) => r.querySelector(".palette-title")!.textContent);
const activeIndex = () => rows().findIndex((r) => r.classList.contains("active"));
const input = () => document.querySelector<HTMLInputElement>(".palette-input")!;
const key = (k: string, o: KeyboardEventInit = {}) =>
  input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...o }));
const type = async (value: string) => {
  input().value = value;
  input().dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(document.querySelector(".palette-list")).toBeTruthy());
  await Promise.resolve();
  await Promise.resolve();
};

let files: PaletteItem[];
let commands: PaletteItem[];
let outline: PaletteItem[];
let palette: CommandPalette;

beforeEach(() => {
  files = [
    item("welcome", { subtitle: undefined, search: "welcome.md" }),
    item("ideas", { subtitle: "journal", search: "journal/ideas.md" }),
    item("2026-07-23", { subtitle: "journal", search: "journal/2026-07-23.md" }),
  ];
  commands = [
    item("Toggle Split Preview", { subtitle: "⌘⇧V", icon: ICON_COMMAND }),
    item("Save As…", { subtitle: "⌘⇧S", icon: ICON_COMMAND }),
  ];
  outline = [item("Tables", { subtitle: "H2", icon: ICON_HEADING })];
  palette = new CommandPalette({
    files: () => files,
    commands: () => commands,
    outline: () => outline,
  });
});

describe("chrome", () => {
  it("builds a search icon, an input and a dismiss button", async () => {
    await palette.show();
    expect(document.querySelector(".palette-search-icon svg")).toBeTruthy();
    expect(document.querySelector(".palette-close")).toBeTruthy();
    expect(document.querySelector(".palette-box")!.getAttribute("aria-modal")).toBe(
      "true",
    );
  });

  it("starts hidden", () => {
    expect(document.querySelector(".palette")!.classList.contains("hidden")).toBe(true);
    expect(palette.isOpen).toBe(false);
  });

  it("closes on the dismiss button", async () => {
    await palette.show();
    document.querySelector<HTMLButtonElement>(".palette-close")!.click();
    expect(palette.isOpen).toBe(false);
  });

  it("closes when the backdrop is clicked but not the box", async () => {
    await palette.show();
    document
      .querySelector(".palette-box")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(palette.isOpen).toBe(true);
    document
      .querySelector(".palette")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(palette.isOpen).toBe(false);
  });
});

describe("modes", () => {
  it("lists files by default", async () => {
    await palette.show();
    expect(titles()).toEqual(["welcome", "ideas", "2026-07-23"]);
  });

  it("switches to commands on >", async () => {
    await palette.show(">");
    expect(titles()).toEqual(["Toggle Split Preview", "Save As…"]);
  });

  it("switches to headings on #", async () => {
    await palette.show("#");
    expect(titles()).toEqual(["Tables"]);
  });

  it("changes the placeholder with the mode", async () => {
    await palette.show();
    const filesPlaceholder = input().placeholder;
    await type(">");
    expect(input().placeholder).not.toBe(filesPlaceholder);
  });

  it("switches modes as the prefix is typed, without reopening", async () => {
    await palette.show();
    await type(">save");
    expect(titles()).toEqual(["Save As…"]);
    await type("");
    expect(titles()).toEqual(["welcome", "ideas", "2026-07-23"]);
  });
});

describe("filtering", () => {
  it("matches on the title", async () => {
    await palette.show();
    await type("ideas");
    expect(titles()).toEqual(["ideas"]);
  });

  it("matches on the full path even though the row shows only the folder", async () => {
    // The row's meta column shows "journal", but typing the whole relative
    // path must still find it — that's what the separate search field is for.
    await palette.show();
    await type("journal/ideas");
    expect(titles()).toEqual(["ideas"]);
  });

  it("says so when nothing matches", async () => {
    await palette.show();
    await type("zzzzz");
    expect(rows()).toHaveLength(0);
    expect(document.querySelector(".palette-empty")!.textContent).toBe("No matches");
  });

  it("matches an item that has neither meta text nor a search field", async () => {
    files = [item("standalone")];
    await palette.show();
    await type("standalone");
    expect(titles()).toEqual(["standalone"]);
  });

  it("ignores case", async () => {
    await palette.show();
    await type("IDEAS");
    expect(titles()).toEqual(["ideas"]);
  });

  it("resets the highlight to the top after filtering", async () => {
    await palette.show();
    key("ArrowDown");
    key("ArrowDown");
    expect(activeIndex()).toBe(2);
    await type("journal");
    expect(activeIndex()).toBe(0);
  });
});

describe("rendering", () => {
  it("shows the icon, title and meta column", async () => {
    await palette.show(">");
    const row = rows()[0];
    expect(row.querySelector(".palette-glyph svg")).toBeTruthy();
    expect(row.querySelector(".palette-title")!.textContent).toBe(
      "Toggle Split Preview",
    );
    expect(row.querySelector(".palette-sub")!.textContent).toBe("⌘⇧V");
  });

  it("omits the meta column when there is nothing to put in it", async () => {
    await palette.show();
    expect(rows()[0].querySelector(".palette-sub")).toBe(null);
    expect(rows()[1].querySelector(".palette-sub")!.textContent).toBe("journal");
  });

  it("puts a return hint on every row for the stylesheet to reveal", async () => {
    await palette.show();
    expect(rows()[0].querySelector(".palette-enter svg")).toBeTruthy();
  });

  it("marks the active row for assistive tech", async () => {
    await palette.show();
    expect(rows()[0].getAttribute("aria-selected")).toBe("true");
    expect(rows()[1].getAttribute("aria-selected")).toBe("false");
    key("ArrowDown");
    expect(rows()[0].getAttribute("aria-selected")).toBe("false");
    expect(rows()[1].getAttribute("aria-selected")).toBe("true");
  });

  it("renders titles as text, so a filename cannot inject markup", async () => {
    files = [item("<img src=x onerror=alert(1)>")];
    await palette.show();
    expect(rows()[0].querySelector(".palette-title")!.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
    expect(rows()[0].querySelector("img")).toBe(null);
  });
});

describe("keyboard", () => {
  it("moves down and up", async () => {
    await palette.show();
    key("ArrowDown");
    expect(activeIndex()).toBe(1);
    key("ArrowUp");
    expect(activeIndex()).toBe(0);
  });

  it("clamps at both ends rather than wrapping", async () => {
    await palette.show();
    key("ArrowUp");
    expect(activeIndex()).toBe(0);
    for (let i = 0; i < 10; i++) key("ArrowDown");
    expect(activeIndex()).toBe(rows().length - 1);
  });

  it("runs the highlighted item on Enter and closes", async () => {
    await palette.show();
    key("ArrowDown");
    key("Enter");
    expect(files[1].run).toHaveBeenCalledOnce();
    expect(files[0].run).not.toHaveBeenCalled();
    expect(palette.isOpen).toBe(false);
  });

  it("closes on Escape without running anything", async () => {
    await palette.show();
    key("Escape");
    expect(palette.isOpen).toBe(false);
    expect(files[0].run).not.toHaveBeenCalled();
  });

  it("does nothing on Enter with no matches", async () => {
    await palette.show();
    await type("zzzzz");
    expect(() => key("Enter")).not.toThrow();
    expect(files.every((f) => (f.run as ReturnType<typeof vi.fn>).mock.calls.length === 0)).toBe(true);
  });

  it("ignores keys it doesn't handle", async () => {
    await palette.show();
    key("a");
    expect(palette.isOpen).toBe(true);
    expect(activeIndex()).toBe(0);
  });
});

describe("mouse", () => {
  it("runs an item on click", async () => {
    await palette.show();
    rows()[2].click();
    expect(files[2].run).toHaveBeenCalledOnce();
    expect(palette.isOpen).toBe(false);
  });

  it("follows the pointer with the highlight", async () => {
    await palette.show();
    rows()[2].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(activeIndex()).toBe(2);
  });
});

describe("fuzzy engine fallbacks", () => {
  /** uFuzzy attaches `search` to the instance, so stub it there. */
  const stubMatcher = (result: unknown) => {
    (palette as unknown as { uf: { search: () => unknown } }).uf.search = () => result;
  };

  it("still lists results when the matcher returns no ranking", async () => {
    // uFuzzy returns [idxs, info, order]; info and order are null when it
    // declines to rank. The bare index list must still drive the list.
    stubMatcher([[2, 0], null, null]);
    await palette.show();
    await type("x");
    expect(titles()).toEqual(["2026-07-23", "welcome"]);
  });

  it("shows no matches when the matcher returns nothing at all", async () => {
    stubMatcher([null, null, null]);
    await palette.show();
    await type("x");
    expect(rows()).toHaveLength(0);
    expect(document.querySelector(".palette-empty")).toBeTruthy();
  });
});

describe("data loading", () => {
  it("clears the input and list on close, so it reopens clean", async () => {
    await palette.show();
    await type("ideas");
    palette.close();
    expect(input().value).toBe("");
    expect(rows()).toHaveLength(0);
  });

  it("loads a mode's items once per open, not once per keystroke", async () => {
    const filesProvider = vi.fn(() => files);
    palette = new CommandPalette({
      files: filesProvider,
      commands: () => commands,
      outline: () => outline,
    });
    await palette.show();
    await type("i");
    await type("id");
    await type("ide");
    expect(filesProvider).toHaveBeenCalledOnce();
  });

  it("re-reads on the next open, so a changed folder is picked up", async () => {
    const filesProvider = vi.fn(() => files);
    palette = new CommandPalette({
      files: filesProvider,
      commands: () => commands,
      outline: () => outline,
    });
    await palette.show();
    palette.close();
    await palette.show();
    expect(filesProvider).toHaveBeenCalledTimes(2);
  });

  it("awaits an async file provider", async () => {
    palette = new CommandPalette({
      files: async () => files,
      commands: () => commands,
      outline: () => outline,
    });
    await palette.show();
    expect(titles()).toEqual(["welcome", "ideas", "2026-07-23"]);
  });

  it("drops a slow response that lost its race", async () => {
    // A folder walk that resolves after the palette closed must not repaint it.
    let release!: (v: PaletteItem[]) => void;
    palette = new CommandPalette({
      files: () => new Promise<PaletteItem[]>((r) => (release = r)),
      commands: () => commands,
      outline: () => outline,
    });
    const showing = palette.show();
    palette.close();
    release(files);
    await showing;
    expect(rows()).toHaveLength(0);
  });
});
