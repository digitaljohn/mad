// Edge paths: an empty tree, a tree with no workspace, and the guards that only
// fire when something upstream is in an unusual state.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileTree, type TreeCallbacks } from "./tree";
import type { Backend, Entry } from "./backend";

let backend: Backend;
let cb: TreeCallbacks;
let container: HTMLElement;

const makeTree = (fs: Record<string, Entry[]> = {}) => {
  backend = {
    listDir: vi.fn(async (p: string) => fs[p] ?? []),
    duplicatePath: vi.fn(),
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
  return new FileTree(container, backend, cb);
};

const key = (k: string) =>
  container.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

beforeEach(() => {
  document.querySelectorAll(".context-menu").forEach((m) => m.remove());
});

describe("before a workspace is opened", () => {
  it("renders nothing rather than throwing", () => {
    const tree = makeTree();
    tree.select("/w/a.md");
    expect(container.children).toHaveLength(0);
  });

  it("accepts a git status with no workspace to anchor it to", () => {
    const tree = makeTree();
    // The upward rollup walk has to terminate even with no root to stop at.
    expect(() =>
      tree.setGit({
        root: "/w",
        entries: [{ path: "/deep/nested/file.md", status: "modified" }],
        truncated: false,
      }),
    ).not.toThrow();
  });

  it("ignores a right-click on empty space", () => {
    makeTree();
    container.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 1, clientY: 1 }),
    );
    expect(document.querySelector(".context-menu")).toBe(null);
  });

  it("ignores a drop with nowhere to move to", () => {
    makeTree();
    const ev = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(ev, "dataTransfer", {
      value: { types: [], getData: () => "/x/y.md" },
    });
    container.dispatchEvent(ev);
    expect(cb.onMove).not.toHaveBeenCalled();
  });
});

describe("keyboard with no row focused", () => {
  // An empty workspace has no rows at all, so every branch that reads the
  // focused row has to cope with there not being one.
  let tree: FileTree;
  beforeEach(async () => {
    tree = makeTree({ "/empty": [] });
    await tree.setRoot("/empty");
  });

  it("has no rows to focus", () => {
    expect(container.querySelectorAll(".tree-row")).toHaveLength(0);
  });

  it("survives every navigation key", () => {
    for (const k of [
      "ArrowDown",
      "ArrowUp",
      "ArrowRight",
      "ArrowLeft",
      "Home",
      "End",
      "Enter",
      " ",
      "F2",
      "Backspace",
      "Delete",
    ]) {
      expect(() => key(k), k).not.toThrow();
    }
    expect(cb.onDelete).not.toHaveBeenCalled();
    expect(cb.onOpenFile).not.toHaveBeenCalled();
    expect(container.querySelector(".rename-input")).toBe(null);
  });
});

describe("right-click on a non-row child", () => {
  it("is ignored, because rows handle their own", async () => {
    const tree = makeTree({ "/empty": [] });
    await tree.setRoot("/empty");
    // .tree-empty is a child of the container but not a row.
    const empty = container.querySelector(".tree-empty")!;
    empty.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 1, clientY: 1 }),
    );
    expect(document.querySelector(".context-menu")).toBe(null);
  });
});

describe("git rollup ordering", () => {
  it("takes the worse state whichever order the two arrive in", async () => {
    const fs: Record<string, Entry[]> = {
      "/w": [{ name: "sub", path: "/w/sub", is_dir: true }],
      "/w/sub": [
        { name: "a.md", path: "/w/sub/a.md", is_dir: false },
        { name: "b.md", path: "/w/sub/b.md", is_dir: false },
      ],
    };
    const tree = makeTree(fs);
    await tree.setRoot("/w");
    await tree.reveal("/w/sub/a.md");
    const dirClass = () =>
      container.querySelector<HTMLElement>(`[data-path="${CSS.escape("/w/sub")}"]`)!
        .className;

    // Worst-first: the second, milder entry must not displace it.
    tree.setGit({
      root: "/w",
      entries: [
        { path: "/w/sub/a.md", status: "conflict" },
        { path: "/w/sub/b.md", status: "modified" },
      ],
      truncated: false,
    });
    expect(dirClass()).toContain("git-conflict");

    // Mildest-first: the later, worse entry must win.
    tree.setGit({
      root: "/w",
      entries: [
        { path: "/w/sub/a.md", status: "modified" },
        { path: "/w/sub/b.md", status: "conflict" },
      ],
      truncated: false,
    });
    expect(dirClass()).toContain("git-conflict");
  });
});

describe("a directory that is both an entry and a rollup target", () => {
  it("takes its own state when that is the worse of the two", async () => {
    // A submodule reported as conflicted, containing a merely modified file:
    // the folder must show the conflict, not the milder rollup.
    const tree = makeTree({
      "/w": [{ name: "vendor", path: "/w/vendor", is_dir: true }],
      "/w/vendor": [{ name: "guide.md", path: "/w/vendor/guide.md", is_dir: false }],
    });
    await tree.setRoot("/w");
    await tree.reveal("/w/vendor/guide.md");
    tree.setGit({
      root: "/w",
      entries: [
        { path: "/w/vendor", status: "conflict" },
        { path: "/w/vendor/guide.md", status: "modified" },
      ],
      truncated: false,
    });
    const dir = container.querySelector<HTMLElement>(
      `[data-path="${CSS.escape("/w/vendor")}"]`,
    )!;
    expect(dir.className).toContain("git-conflict");
  });
});

describe("rename commit guards", () => {
  it("does not also cancel after committing", async () => {
    const tree = makeTree({
      "/w": [{ name: "a.md", path: "/w/a.md", is_dir: false }],
    });
    await tree.setRoot("/w");
    tree.startRename("/w/a.md");
    const input = container.querySelector<HTMLInputElement>(".rename-input")!;
    input.value = "b.md";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(cb.onRename).toHaveBeenCalledOnce();
    // A stray Escape arriving after the commit must be a no-op, not a second
    // render that reverts the row.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(cb.onRename).toHaveBeenCalledOnce();
  });

  it("does not commit after cancelling", async () => {
    const tree = makeTree({
      "/w": [{ name: "a.md", path: "/w/a.md", is_dir: false }],
    });
    await tree.setRoot("/w");
    tree.startRename("/w/a.md");
    const input = container.querySelector<HTMLInputElement>(".rename-input")!;
    input.value = "b.md";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur"));
    expect(cb.onRename).not.toHaveBeenCalled();
  });
});
