// The context-menu actions, the clipboard helper and the failure paths — the
// parts of tree.ts that only run when a menu item is actually clicked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileTree, type TreeCallbacks } from "./tree";
import { TREE_MOVE_DND } from "./dnd";
import type { Backend, Entry } from "./backend";

const FS: Record<string, Entry[]> = {
  "/w": [
    { name: "journal", path: "/w/journal", is_dir: true },
    { name: "README.md", path: "/w/README.md", is_dir: false },
  ],
  "/w/journal": [{ name: "ideas.md", path: "/w/journal/ideas.md", is_dir: false }],
};

let backend: Backend;
let cb: TreeCallbacks;
let container: HTMLElement;
let tree: FileTree;

const row = (p: string) =>
  container.querySelector<HTMLElement>(`[data-path="${CSS.escape(p)}"]`)!;
const openRowMenu = (p: string) =>
  row(p).dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
  );
const openRootMenu = () =>
  container.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
  );
/** Click a menu entry by its exact label. */
const clickItem = (label: string) => {
  const btn = [...document.querySelectorAll<HTMLButtonElement>(".context-menu-item")].find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`no menu item "${label}" in [${
    [...document.querySelectorAll(".context-menu-item")].map((b) => b.textContent).join(", ")
  }]`);
  btn.click();
};
const toastTexts = () =>
  [...document.querySelectorAll(".toast-text")].map((t) => t.textContent);

beforeEach(async () => {
  document.querySelectorAll(".context-menu").forEach((m) => m.remove());
  backend = {
    listDir: vi.fn(async (p: string) => FS[p] ?? []),
    duplicatePath: vi.fn(async (p: string) => p.replace(/\.md$/, " copy.md")),
    revealPath: vi.fn(async () => {}),
    openPath: vi.fn(async () => {}),
  } as unknown as Backend;
  cb = {
    onOpenFile: vi.fn(),
    onRename: vi.fn(),
    onMove: vi.fn(),
    onNewFile: vi.fn(),
    onNewFolder: vi.fn(),
    onDelete: vi.fn(),
    onShowDiff: vi.fn(),
    onDiscard: vi.fn(),
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  tree = new FileTree(container, backend, cb);
  await tree.setRoot("/w");
});

describe("row menu actions", () => {
  it("creates a file and a folder in the right directory", () => {
    openRowMenu("/w/README.md");
    clickItem("New File");
    expect(cb.onNewFile).toHaveBeenCalledWith("/w");

    openRowMenu("/w/journal");
    clickItem("New Folder");
    expect(cb.onNewFolder).toHaveBeenCalledWith("/w/journal");
  });

  it("starts an inline rename", () => {
    openRowMenu("/w/README.md");
    clickItem("Rename");
    expect(container.querySelector(".rename-input")).toBeTruthy();
  });

  it("asks to delete, distinguishing files from folders", () => {
    openRowMenu("/w/README.md");
    clickItem("Delete");
    expect(cb.onDelete).toHaveBeenCalledWith("/w/README.md", false);

    openRowMenu("/w/journal");
    clickItem("Delete Folder");
    expect(cb.onDelete).toHaveBeenCalledWith("/w/journal", true);
  });

  it("opens a file in the OS default app", () => {
    openRowMenu("/w/README.md");
    clickItem("Open in Default App");
    expect(backend.openPath).toHaveBeenCalledWith("/w/README.md");
  });

  it("reveals a row in the file manager", () => {
    openRowMenu("/w/README.md");
    clickItem("Reveal in Finder");
    expect(backend.revealPath).toHaveBeenCalledWith("/w/README.md");
  });

  it("duplicates, then reveals and announces the copy", async () => {
    openRowMenu("/w/README.md");
    clickItem("Duplicate");
    await vi.waitFor(() =>
      expect(toastTexts()).toContain("Duplicated as “README copy.md”"),
    );
    expect(backend.duplicatePath).toHaveBeenCalledWith("/w/README.md");
  });

  it("reports a duplicate failure instead of failing silently", async () => {
    (backend.duplicatePath as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("read-only volume"),
    );
    openRowMenu("/w/README.md");
    clickItem("Duplicate");
    await vi.waitFor(() =>
      expect(toastTexts()).toContain("Couldn’t duplicate: read-only volume"),
    );
  });

  it("reports a reveal failure", async () => {
    (backend.revealPath as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("no such file"),
    );
    openRowMenu("/w/README.md");
    clickItem("Reveal in Finder");
    await vi.waitFor(() =>
      expect(toastTexts()).toContain("Couldn’t reveal: no such file"),
    );
  });

  it("reports an open-in-default-app failure", async () => {
    (backend.openPath as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("no handler"),
    );
    openRowMenu("/w/README.md");
    clickItem("Open in Default App");
    await vi.waitFor(() => expect(toastTexts()).toContain("Couldn’t open: no handler"));
  });

  it("routes Discard Changes with the file's status", () => {
    tree.setGit({
      root: "/w",
      entries: [{ path: "/w/README.md", status: "modified" }],
      truncated: false,
    });
    openRowMenu("/w/README.md");
    clickItem("Discard Changes…");
    expect(cb.onDiscard).toHaveBeenCalledWith("/w/README.md", "modified");
  });
});

describe("root menu actions", () => {
  it("creates in the workspace root", () => {
    openRootMenu();
    clickItem("New File");
    expect(cb.onNewFile).toHaveBeenCalledWith("/w");
    openRootMenu();
    clickItem("New Folder");
    expect(cb.onNewFolder).toHaveBeenCalledWith("/w");
  });

  it("reveals the workspace root", () => {
    openRootMenu();
    clickItem("Reveal in Finder");
    expect(backend.revealPath).toHaveBeenCalledWith("/w");
  });

  it("reports a failure revealing the root", async () => {
    (backend.revealPath as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("gone"),
    );
    openRootMenu();
    clickItem("Reveal in Finder");
    await vi.waitFor(() => expect(toastTexts()).toContain("Couldn’t reveal: gone"));
  });
});

describe("Copy Path", () => {
  it("writes the path to the clipboard and says so", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    openRowMenu("/w/journal");
    clickItem("Copy Path");
    await vi.waitFor(() => expect(toastTexts()).toContain("Path copied"));
    expect(writeText).toHaveBeenCalledWith("/w/journal");
  });

  it("copies the workspace root from the root menu", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    openRootMenu();
    clickItem("Copy Path");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("/w"));
  });

  it("falls back to execCommand when the clipboard API is blocked", async () => {
    // Denied permission or a non-secure context: the copy must still work.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error("NotAllowedError");
        }),
      },
    });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      writable: true,
      value: exec,
    });
    openRowMenu("/w/README.md");
    clickItem("Copy Path");
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith("copy"));
    // The scratch textarea must not be left behind in the document.
    expect(document.querySelector("textarea")).toBe(null);
    expect(toastTexts()).toContain("Path copied");
  });

  it("says so when even the fallback fails, rather than claiming success", async () => {
    // Both routes blocked. Silence here would leave the user believing a
    // path was on their clipboard when nothing was.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error("NotAllowedError");
        }),
      },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error("blocked");
      },
    });

    openRowMenu("/w/README.md");
    clickItem("Copy Path");
    await vi.waitFor(() => expect(toastTexts()).toContain("Couldn’t copy path"));
    expect(toastTexts()).not.toContain("Path copied");
  });

  it("reports a failed copy of the workspace root too", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error("NotAllowedError");
        }),
      },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error("blocked");
      },
    });

    openRootMenu();
    clickItem("Copy Path");
    await vi.waitFor(() => expect(toastTexts()).toContain("Couldn’t copy path"));
  });
});

describe("menu dismissal", () => {
  it("closes when the click lands outside it", () => {
    openRowMenu("/w/README.md");
    expect(document.querySelector(".context-menu")).toBeTruthy();
    // The handler is registered on a timeout so the opening click can't close it.
    return vi.waitFor(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(document.querySelector(".context-menu")).toBe(null);
    });
  });

  it("stays open when the click lands inside it", async () => {
    openRowMenu("/w/README.md");
    await new Promise((r) => setTimeout(r, 0));
    document
      .querySelector(".context-menu")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".context-menu")).toBeTruthy();
  });

  it("closes when the window loses focus", async () => {
    openRowMenu("/w/README.md");
    window.dispatchEvent(new Event("blur"));
    expect(document.querySelector(".context-menu")).toBe(null);
  });

  it("ignores other keys while open", async () => {
    openRowMenu("/w/README.md");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(document.querySelector(".context-menu")).toBeTruthy();
  });
});

describe("drag over empty space", () => {
  it("accepts one of our move drags", () => {
    const ev = new Event("dragover", { bubbles: true, cancelable: true }) as DragEvent;
    const dt = {
      types: [TREE_MOVE_DND],
      getData: () => "/w/README.md",
      dropEffect: "",
    };
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    container.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe("move");
  });

  it("ignores a drag of some other type", () => {
    const ev = new Event("dragover", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(ev, "dataTransfer", {
      value: { types: ["Files"], getData: () => "", dropEffect: "" },
    });
    container.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("keyboard fall-through", () => {
  it("leaves keys it doesn't own alone", () => {
    row("/w/README.md").focus();
    const ev = new KeyboardEvent("keydown", {
      key: "x",
      bubbles: true,
      cancelable: true,
    });
    container.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("does nothing when no row has focus", () => {
    const ev = new KeyboardEvent("keydown", { key: "F2", bubbles: true });
    container.dispatchEvent(ev);
    expect(container.querySelector(".rename-input")).toBeTruthy();
  });
});
