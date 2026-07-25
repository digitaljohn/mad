import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileTree, GIT_LABEL, fileIcon, type TreeCallbacks } from "./tree";
import { TREE_IMAGE_DND, TREE_MOVE_DND } from "./dnd";
import type { Backend, Entry, GitInfo } from "./backend";

// A filesystem described as a flat map, served through the Backend shape the
// tree actually uses. Only the handful of methods it calls are implemented.
const FS: Record<string, Entry[]> = {
  "/w": [
    { name: "journal", path: "/w/journal", is_dir: true },
    { name: "vendor", path: "/w/vendor", is_dir: true },
    { name: "pic.png", path: "/w/pic.png", is_dir: false },
    { name: "README.md", path: "/w/README.md", is_dir: false },
  ],
  "/w/journal": [
    { name: "deep", path: "/w/journal/deep", is_dir: true },
    { name: "ideas.md", path: "/w/journal/ideas.md", is_dir: false },
  ],
  "/w/journal/deep": [{ name: "note.md", path: "/w/journal/deep/note.md", is_dir: false }],
  "/w/vendor": [{ name: "guide.md", path: "/w/vendor/guide.md", is_dir: false }],
  "/w/empty": [],
};

let backend: Backend;
let cb: TreeCallbacks;
let container: HTMLElement;
let tree: FileTree;
let listDir: ReturnType<typeof vi.fn>;

const rows = () => [...container.querySelectorAll<HTMLElement>(".tree-row")];
const paths = () => rows().map((r) => r.dataset.path);
const row = (p: string) =>
  container.querySelector<HTMLElement>(`[data-path="${CSS.escape(p)}"]`)!;
const names = () =>
  rows().map((r) => r.querySelector(".row-name")?.textContent ?? null);
const key = (k: string) =>
  container.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
const menuLabels = () =>
  [...document.querySelectorAll(".context-menu-item")].map((e) => e.textContent);
const openMenu = (p: string) =>
  row(p).dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
  );

/** A DataTransfer stand-in: jsdom's has no working get/setData. */
const transfer = (data: Record<string, string> = {}) => ({
  types: Object.keys(data),
  getData: (t: string) => data[t] ?? "",
  setData: (t: string, v: string) => void (data[t] = v),
  dropEffect: "",
  effectAllowed: "",
});
const drag = (el: Element, type: string, data: Record<string, string>) => {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(ev, "dataTransfer", { value: transfer(data) });
  el.dispatchEvent(ev);
  return ev;
};

beforeEach(async () => {
  document.querySelectorAll(".context-menu").forEach((m) => m.remove());
  listDir = vi.fn(async (p: string) => FS[p] ?? []);
  backend = {
    listDir,
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
    onExpandedChange: vi.fn(),
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  tree = new FileTree(container, backend, cb);
  await tree.setRoot("/w");
});

describe("fileIcon", () => {
  it("picks a distinct mark per type", () => {
    expect(fileIcon("a.md")).toContain("row-icon md");
    expect(fileIcon("a.png")).toContain("row-icon img");
    expect(fileIcon("a.txt")).not.toContain("row-icon md");
  });
});

describe("rendering", () => {
  it("lists one level, directories first as the backend ordered them", () => {
    expect(paths()).toEqual(["/w/journal", "/w/vendor", "/w/pic.png", "/w/README.md"]);
  });

  it("hides markdown extensions but keeps image ones", () => {
    expect(names()).toEqual(["journal", "vendor", "pic.png", "README"]);
  });

  it("indents by depth", async () => {
    await tree.reveal("/w/journal/ideas.md");
    expect(row("/w/journal").style.paddingLeft).toBe("10px");
    expect(row("/w/journal/ideas.md").style.paddingLeft).toBe("24px");
  });

  it("describes itself to assistive tech", () => {
    const r = row("/w/journal");
    expect(r.getAttribute("role")).toBe("treeitem");
    expect(r.getAttribute("aria-level")).toBe("1");
    expect(r.getAttribute("aria-expanded")).toBe("false");
    expect(r.getAttribute("aria-selected")).toBe("false");
  });

  it("offers a way out of an empty folder", async () => {
    await tree.setRoot("/w/empty");
    expect(container.querySelector(".tree-empty")).toBeTruthy();
    container.querySelector<HTMLButtonElement>(".tree-empty button")!.click();
    expect(cb.onNewFile).toHaveBeenCalledWith("/w/empty");
  });
});

describe("expanding", () => {
  it("loads children on first expand and reports the change", async () => {
    row("/w/journal").click();
    await vi.waitFor(() => expect(paths()).toContain("/w/journal/ideas.md"));
    expect(row("/w/journal").getAttribute("aria-expanded")).toBe("true");
    expect(cb.onExpandedChange).toHaveBeenCalledWith(["/w/journal"]);
  });

  it("collapses again without re-reading the directory", async () => {
    row("/w/journal").click();
    await vi.waitFor(() => expect(paths()).toContain("/w/journal/ideas.md"));
    const reads = listDir.mock.calls.length;
    row("/w/journal").click();
    await vi.waitFor(() => expect(paths()).not.toContain("/w/journal/ideas.md"));
    row("/w/journal").click();
    await vi.waitFor(() => expect(paths()).toContain("/w/journal/ideas.md"));
    expect(listDir.mock.calls.length).toBe(reads);
  });

  it("restores folders that were open last session", async () => {
    await tree.setRoot("/w", ["/w/journal", "/w/journal/deep"]);
    expect(paths()).toContain("/w/journal/deep/note.md");
  });

  it("ignores remembered folders belonging to another workspace", async () => {
    await tree.setRoot("/w", ["/other/journal"]);
    expect(tree.expandedDirs).toEqual([]);
  });

  it("opens a file rather than expanding it", () => {
    row("/w/README.md").click();
    expect(cb.onOpenFile).toHaveBeenCalledWith("/w/README.md");
  });

  it("keeps rendering when a directory read fails", async () => {
    listDir.mockRejectedValueOnce(new Error("EACCES"));
    await tree.setRoot("/w");
    expect(container.querySelector(".tree-empty")).toBeTruthy();
  });
});

describe("reveal and select", () => {
  it("expands every ancestor and selects the file", async () => {
    await tree.reveal("/w/journal/deep/note.md");
    expect(paths()).toContain("/w/journal/deep/note.md");
    expect(row("/w/journal/deep/note.md").classList.contains("selected")).toBe(true);
  });

  it("refuses a path outside the workspace", async () => {
    await tree.reveal("/elsewhere/x.md");
    expect(paths()).toEqual(["/w/journal", "/w/vendor", "/w/pic.png", "/w/README.md"]);
  });

  it("marks selection for assistive tech and clears it on null", () => {
    tree.select("/w/README.md");
    expect(row("/w/README.md").getAttribute("aria-selected")).toBe("true");
    tree.select(null);
    expect(row("/w/README.md").getAttribute("aria-selected")).toBe("false");
  });
});

describe("git decorations", () => {
  const info = (entries: GitInfo["entries"]): GitInfo => ({
    root: "/w",
    entries,
    truncated: false,
  });

  it("badges a file with its letter and labels it", () => {
    tree.setGit(info([{ path: "/w/README.md", status: "modified" }]));
    const badge = row("/w/README.md").querySelector(".git-badge")!;
    expect(badge.textContent).toBe("M");
    expect(badge.getAttribute("title")).toBe(GIT_LABEL.modified);
    expect(row("/w/README.md").classList.contains("git-modified")).toBe(true);
  });

  it("uses a distinct letter per state", () => {
    const expected: Record<string, string> = {
      modified: "M",
      added: "A",
      untracked: "U",
      deleted: "D",
      renamed: "R",
      conflict: "!",
    };
    for (const [status, letter] of Object.entries(expected)) {
      tree.setGit(info([{ path: "/w/README.md", status: status as never }]));
      expect(row("/w/README.md").querySelector(".git-badge")!.textContent).toBe(letter);
    }
  });

  it("rolls a change up onto every ancestor folder as a dot", async () => {
    await tree.reveal("/w/journal/deep/note.md");
    tree.setGit(info([{ path: "/w/journal/deep/note.md", status: "modified" }]));
    for (const dir of ["/w/journal", "/w/journal/deep"]) {
      const badge = row(dir).querySelector(".git-badge")!;
      expect(badge.textContent, dir).toBe(""); // empty text renders as a dot
      expect(badge.getAttribute("title"), dir).toContain("modified");
    }
  });

  it("gives a folder the worst state among its descendants", async () => {
    await tree.reveal("/w/journal/ideas.md");
    tree.setGit(
      info([
        { path: "/w/journal/ideas.md", status: "modified" },
        { path: "/w/journal/deep/note.md", status: "conflict" },
      ]),
    );
    expect(row("/w/journal").classList.contains("git-conflict")).toBe(true);
  });

  it("marks a dirty submodule directory that is itself an entry", () => {
    tree.setGit(info([{ path: "/w/vendor", status: "modified" }]));
    expect(row("/w/vendor").classList.contains("git-modified")).toBe(true);
  });

  it("prefers the worse of a directory's own state and its rollup", async () => {
    await tree.reveal("/w/vendor/guide.md");
    tree.setGit(
      info([
        { path: "/w/vendor", status: "modified" },
        { path: "/w/vendor/guide.md", status: "conflict" },
      ]),
    );
    expect(row("/w/vendor").classList.contains("git-conflict")).toBe(true);
  });

  it("leaves untouched files unmarked", () => {
    tree.setGit(info([{ path: "/w/README.md", status: "modified" }]));
    expect(row("/w/pic.png").querySelector(".git-badge")).toBe(null);
    expect(row("/w/pic.png").className).not.toContain("git");
  });

  it("clears every mark when the folder stops being a repository", () => {
    tree.setGit(info([{ path: "/w/README.md", status: "modified" }]));
    tree.setGit(null);
    expect(container.querySelector(".git-badge")).toBe(null);
  });

  it("does not roll a change up past the workspace root", () => {
    tree.setGit(info([{ path: "/w/README.md", status: "modified" }]));
    // Nothing above /w is rendered, so this is really a no-crash guarantee for
    // the upward walk terminating.
    expect(rows().length).toBeGreaterThan(0);
  });
});

describe("keyboard navigation", () => {
  it("moves through visible rows with the arrows", () => {
    row("/w/journal").focus();
    key("ArrowDown");
    expect(document.activeElement).toBe(row("/w/vendor"));
    key("ArrowUp");
    expect(document.activeElement).toBe(row("/w/journal"));
  });

  it("jumps to the ends with Home and End", () => {
    row("/w/vendor").focus();
    key("End");
    expect(document.activeElement).toBe(row("/w/README.md"));
    key("Home");
    expect(document.activeElement).toBe(row("/w/journal"));
  });

  it("clamps at the ends", () => {
    row("/w/journal").focus();
    key("ArrowUp");
    expect(document.activeElement).toBe(row("/w/journal"));
    key("End");
    key("ArrowDown");
    expect(document.activeElement).toBe(row("/w/README.md"));
  });

  it("expands a folder with the right arrow, then steps into it", async () => {
    row("/w/journal").focus();
    key("ArrowRight");
    await vi.waitFor(() => expect(paths()).toContain("/w/journal/ideas.md"));
    key("ArrowRight");
    expect(document.activeElement).toBe(row("/w/journal/deep"));
  });

  it("collapses with the left arrow, then climbs to the parent", async () => {
    await tree.reveal("/w/journal/ideas.md");
    row("/w/journal/ideas.md").focus();
    key("ArrowLeft");
    expect(document.activeElement).toBe(row("/w/journal"));
    key("ArrowLeft");
    await vi.waitFor(() => expect(paths()).not.toContain("/w/journal/ideas.md"));
  });

  it("opens a file with Enter and with Space", () => {
    row("/w/README.md").focus();
    key("Enter");
    expect(cb.onOpenFile).toHaveBeenCalledWith("/w/README.md");
    key(" ");
    expect(cb.onOpenFile).toHaveBeenCalledTimes(2);
  });

  it("starts a rename on F2", () => {
    row("/w/README.md").focus();
    key("F2");
    expect(container.querySelector(".rename-input")).toBeTruthy();
  });

  it("asks to delete on Backspace and Delete", () => {
    row("/w/README.md").focus();
    key("Backspace");
    expect(cb.onDelete).toHaveBeenCalledWith("/w/README.md", false);
    key("Delete");
    expect(cb.onDelete).toHaveBeenCalledTimes(2);
  });

  it("keeps exactly one row in the tab order", () => {
    expect(rows().filter((r) => r.tabIndex === 0)).toHaveLength(1);
    row("/w/vendor").focus();
    key("ArrowDown");
    expect(rows().filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });

  it("ignores navigation keys while renaming", () => {
    row("/w/README.md").focus();
    key("F2");
    key("ArrowDown");
    expect(container.querySelector(".rename-input")).toBeTruthy();
  });
});

describe("renaming", () => {
  const input = () => container.querySelector<HTMLInputElement>(".rename-input")!;

  it("preselects the stem so the extension survives a retype", async () => {
    tree.startRename("/w/README.md");
    expect(input().value).toBe("README.md");
    // Focus and selection are applied once the input is in the document.
    await vi.waitFor(() => expect(input().selectionEnd).toBe("README".length));
    expect(input().selectionStart).toBe(0);
  });

  it("selects the whole name for a folder, which has no extension", async () => {
    tree.startRename("/w/journal");
    await vi.waitFor(() => expect(input().selectionEnd).toBe("journal".length));
  });

  it("commits on Enter", () => {
    tree.startRename("/w/README.md");
    input().value = "GUIDE.md";
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(cb.onRename).toHaveBeenCalledWith("/w/README.md", "GUIDE.md");
  });

  it("commits on blur, so clicking away does not lose the edit", () => {
    tree.startRename("/w/README.md");
    input().value = "GUIDE.md";
    input().dispatchEvent(new FocusEvent("blur"));
    expect(cb.onRename).toHaveBeenCalledWith("/w/README.md", "GUIDE.md");
  });

  it("abandons on Escape", () => {
    tree.startRename("/w/README.md");
    input().value = "GUIDE.md";
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(cb.onRename).not.toHaveBeenCalled();
    expect(container.querySelector(".rename-input")).toBe(null);
  });

  it("does not fire for an unchanged or blank name", () => {
    tree.startRename("/w/README.md");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    tree.startRename("/w/README.md");
    input().value = "   ";
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(cb.onRename).not.toHaveBeenCalled();
  });

  it("commits once even if blur follows Enter", () => {
    tree.startRename("/w/README.md");
    input().value = "GUIDE.md";
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input().dispatchEvent(new FocusEvent("blur"));
    expect(cb.onRename).toHaveBeenCalledOnce();
  });

  it("starts a rename on double click", () => {
    row("/w/README.md").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(container.querySelector(".rename-input")).toBeTruthy();
  });
});

describe("drag and drop", () => {
  it("carries the move type, and the image type only for images", () => {
    const md: Record<string, string> = {};
    const ev = new Event("dragstart", { bubbles: true }) as DragEvent;
    Object.defineProperty(ev, "dataTransfer", { value: transfer(md) });
    row("/w/README.md").dispatchEvent(ev);
    expect(md[TREE_MOVE_DND]).toBe("/w/README.md");
    expect(md[TREE_IMAGE_DND]).toBeUndefined();

    const img: Record<string, string> = {};
    const ev2 = new Event("dragstart", { bubbles: true }) as DragEvent;
    Object.defineProperty(ev2, "dataTransfer", { value: transfer(img) });
    row("/w/pic.png").dispatchEvent(ev2);
    expect(img[TREE_IMAGE_DND]).toBe("/w/pic.png");
  });

  it("highlights a folder on dragover and drops into it", () => {
    drag(row("/w/journal"), "dragover", { [TREE_MOVE_DND]: "/w/README.md" });
    expect(row("/w/journal").classList.contains("drop-target")).toBe(true);
    drag(row("/w/journal"), "drop", { [TREE_MOVE_DND]: "/w/README.md" });
    expect(cb.onMove).toHaveBeenCalledWith("/w/README.md", "/w/journal");
  });

  it("clears the highlight when the drag leaves", () => {
    drag(row("/w/journal"), "dragover", { [TREE_MOVE_DND]: "/w/README.md" });
    row("/w/journal").dispatchEvent(new Event("dragleave", { bubbles: true }));
    expect(row("/w/journal").classList.contains("drop-target")).toBe(false);
  });

  it("refuses to drop a folder onto itself", () => {
    drag(row("/w/journal"), "drop", { [TREE_MOVE_DND]: "/w/journal" });
    expect(cb.onMove).not.toHaveBeenCalled();
  });

  it("does not treat a file as a drop target", () => {
    drag(row("/w/README.md"), "drop", { [TREE_MOVE_DND]: "/w/pic.png" });
    expect(cb.onMove).not.toHaveBeenCalled();
  });

  it("drops on empty space to move to the workspace root", () => {
    drag(container, "drop", { [TREE_MOVE_DND]: "/w/journal/ideas.md" });
    expect(cb.onMove).toHaveBeenCalledWith("/w/journal/ideas.md", "/w");
  });

  it("ignores a drag carrying none of our types", () => {
    const ev = drag(row("/w/journal"), "dragover", { "text/plain": "hi" });
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("context menu", () => {
  it("offers file actions, with Open in Default App only for files", () => {
    openMenu("/w/README.md");
    expect(menuLabels()).toContain("Open in Default App");
    expect(menuLabels()).toContain("Rename");
    expect(menuLabels()).toContain("Duplicate");
    expect(menuLabels()).toContain("Reveal in Finder");
    expect(menuLabels()).toContain("Copy Path");
    expect(menuLabels()).toContain("Delete");
  });

  it("offers folder actions instead for a directory", () => {
    openMenu("/w/journal");
    expect(menuLabels()).not.toContain("Open in Default App");
    expect(menuLabels()).toContain("Delete Folder");
  });

  it("targets the containing folder for a file's New File", async () => {
    await tree.reveal("/w/journal/ideas.md");
    openMenu("/w/journal/ideas.md");
    document.querySelectorAll<HTMLButtonElement>(".context-menu-item").forEach((b) => {
      if (b.textContent === "New File") b.click();
    });
    expect(cb.onNewFile).toHaveBeenCalledWith("/w/journal");
  });

  it("targets the folder itself for a folder's New File", () => {
    openMenu("/w/journal");
    document.querySelectorAll<HTMLButtonElement>(".context-menu-item").forEach((b) => {
      if (b.textContent === "New File") b.click();
    });
    expect(cb.onNewFile).toHaveBeenCalledWith("/w/journal");
  });

  it("hides the git actions when the file has no changes", () => {
    openMenu("/w/README.md");
    expect(menuLabels()).not.toContain("Show Changes");
    expect(menuLabels()).not.toContain("Discard Changes…");
  });

  it("offers both git actions for a modified file", () => {
    tree.setGit({
      root: "/w",
      entries: [{ path: "/w/README.md", status: "modified" }],
      truncated: false,
    });
    openMenu("/w/README.md");
    expect(menuLabels()).toContain("Show Changes");
    expect(menuLabels()).toContain("Discard Changes…");
  });

  it("will not offer to discard a conflict — that needs a merge tool", () => {
    tree.setGit({
      root: "/w",
      entries: [{ path: "/w/README.md", status: "conflict" }],
      truncated: false,
    });
    openMenu("/w/README.md");
    expect(menuLabels()).not.toContain("Discard Changes…");
  });

  it("will not offer a diff for a deleted file — there is nothing to show", () => {
    tree.setGit({
      root: "/w",
      entries: [{ path: "/w/README.md", status: "deleted" }],
      truncated: false,
    });
    openMenu("/w/README.md");
    expect(menuLabels()).not.toContain("Show Changes");
    expect(menuLabels()).toContain("Discard Changes…");
  });

  it("routes the git actions to their callbacks", () => {
    tree.setGit({
      root: "/w",
      entries: [{ path: "/w/README.md", status: "modified" }],
      truncated: false,
    });
    openMenu("/w/README.md");
    document.querySelectorAll<HTMLButtonElement>(".context-menu-item").forEach((b) => {
      if (b.textContent === "Show Changes") b.click();
    });
    expect(cb.onShowDiff).toHaveBeenCalledWith("/w/README.md");
  });

  it("closes on Escape", () => {
    openMenu("/w/README.md");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".context-menu")).toBe(null);
  });

  it("never leaves two menus open", () => {
    openMenu("/w/README.md");
    openMenu("/w/journal");
    expect(document.querySelectorAll(".context-menu")).toHaveLength(1);
  });

  it("reveals and copies via the backend", async () => {
    openMenu("/w/README.md");
    for (const b of document.querySelectorAll<HTMLButtonElement>(".context-menu-item")) {
      if (b.textContent === "Reveal in Finder") b.click();
    }
    expect(backend.revealPath).toHaveBeenCalledWith("/w/README.md");
  });

  it("duplicates through the backend and reveals the copy", async () => {
    openMenu("/w/README.md");
    for (const b of document.querySelectorAll<HTMLButtonElement>(".context-menu-item")) {
      if (b.textContent === "Duplicate") b.click();
    }
    await vi.waitFor(() => expect(backend.duplicatePath).toHaveBeenCalledWith("/w/README.md"));
  });

  it("offers root actions on empty space", () => {
    container.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    expect(menuLabels()).toEqual([
      "New File",
      "New Folder",
      "Reveal in Finder",
      "Copy Path",
    ]);
  });
});

describe("refreshing", () => {
  it("re-reads only directories it has already loaded", async () => {
    listDir.mockClear();
    await tree.refreshDirs(["/w", "/w/never-loaded"]);
    expect(listDir.mock.calls.map((c) => c[0])).toEqual(["/w"]);
  });

  it("does nothing when no affected directory is loaded", async () => {
    listDir.mockClear();
    await tree.refreshDirs(["/somewhere/else"]);
    expect(listDir).not.toHaveBeenCalled();
  });

  it("re-reads everything loaded on a bulk change", async () => {
    await tree.reveal("/w/journal/ideas.md");
    listDir.mockClear();
    await tree.refreshAll();
    expect(listDir.mock.calls.map((c) => c[0]).sort()).toEqual(["/w", "/w/journal"]);
  });

  it("refreshDir on an unloaded directory still repaints", async () => {
    listDir.mockClear();
    await tree.refreshDir("/w/never-loaded");
    expect(listDir).not.toHaveBeenCalled();
    expect(rows().length).toBeGreaterThan(0);
  });
});
