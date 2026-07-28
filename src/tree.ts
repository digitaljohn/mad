import type { Backend, Entry, GitInfo, GitStatus } from "./backend";
import { TREE_IMAGE_DND, TREE_MOVE_DND } from "./dnd";
import { toast, toastError } from "./toast";

const CHEVRON = `<svg class="chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5 8 6l-3.5 3.5"/></svg>`;
const FILE_ICON = `<svg class="row-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9 1.5Z"/><path d="M9 1.5V5.5H13"/></svg>`;
const FOLDER_ICON = `<svg class="row-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 4a1 1 0 0 1 1-1h3.6a1 1 0 0 1 .8.4l.7 1a1 1 0 0 0 .8.4h5.1a1 1 0 0 1 1 1v6.7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4Z"/></svg>`;
// The classic markdown mark: badge with "M" and a down arrow.
const MD_ICON = `<svg class="row-icon md" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3.25" width="14" height="9.5" rx="2"/><path d="M3.5 10.25v-4.5l1.9 2.2 1.9-2.2v4.5"/><path d="M11.6 5.75v4.5m-1.7-1.8 1.7 1.8 1.7-1.8"/></svg>`;
const IMG_ICON = `<svg class="row-icon img" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.5" width="12" height="11" rx="2"/><circle cx="5.9" cy="6.4" r="1.15"/><path d="M2.5 11.6 6 8.25l2.4 2.35 2.1-2.1 3 3"/></svg>`;

import { IMG_RE, MD_RE, baseOf, isUnder, parentOf } from "./paths";

/** Single-letter badge per git state, and which one wins on a folder. */
const GIT_BADGE: Record<GitStatus, string> = {
  conflict: "!",
  deleted: "D",
  untracked: "U",
  added: "A",
  renamed: "R",
  modified: "M",
};
const GIT_RANK: Record<GitStatus, number> = {
  conflict: 6,
  deleted: 5,
  untracked: 4,
  added: 3,
  renamed: 2,
  modified: 1,
};

/** Whichever of two states should win a shared row. */
function worse(a?: GitStatus, b?: GitStatus): GitStatus | undefined {
  if (!a) return b;
  if (!b) return a;
  return GIT_RANK[a] >= GIT_RANK[b] ? a : b;
}

export const GIT_LABEL: Record<GitStatus, string> = {
  conflict: "Conflicted",
  deleted: "Deleted",
  untracked: "Untracked",
  added: "Added",
  renamed: "Renamed",
  modified: "Modified",
};

export function fileIcon(name: string): string {
  if (MD_RE.test(name)) return MD_ICON;
  if (IMG_RE.test(name)) return IMG_ICON;
  return FILE_ICON;
}

/** Copy text to the clipboard, with a fallback for older webviews. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

export interface TreeCallbacks {
  onOpenFile(path: string): void;
  onRename(path: string, newName: string): void;
  onMove(src: string, destDir: string): void;
  onNewFile(dir: string): void;
  onNewFolder(dir: string): void;
  onDelete(path: string, isDir: boolean): void;
  /** Show the file's uncommitted diff. */
  onShowDiff(path: string): void;
  /** Throw away the file's uncommitted changes. */
  onDiscard(path: string, status: GitStatus): void;
  /** Folder expand/collapse changed — used to persist the session. */
  onExpandedChange?(expanded: string[]): void;
}

export interface MenuItem {
  label: string;
  /** Keyboard equivalent, shown greyed on the right. The only place some of
      these are discoverable at all. */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  action: () => void;
}

/** A minimal cursor-anchored context menu rendered into <body>.
    Exported so the tab strip shares one implementation (Escape, blur
    dismissal and menu roles included) instead of growing a lesser clone. */
export function showContextMenu(x: number, y: number, items: (MenuItem | "-")[]) {
  document.querySelectorAll(".context-menu").forEach((m) => m.remove());
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");
  for (const it of items) {
    if (it === "-") {
      const sep = document.createElement("div");
      sep.className = "context-menu-sep";
      menu.appendChild(sep);
      continue;
    }
    const el = document.createElement("button");
    el.className = "context-menu-item" + (it.danger ? " danger" : "");
    el.setAttribute("role", "menuitem");
    el.disabled = it.disabled ?? false;
    const label = document.createElement("span");
    label.textContent = it.label;
    el.appendChild(label);
    if (it.hint) {
      const hint = document.createElement("span");
      hint.className = "context-menu-hint";
      hint.textContent = it.hint;
      el.appendChild(hint);
    }
    el.addEventListener("click", () => {
      dismiss();
      it.action();
    });
    menu.appendChild(el);
  }
  document.body.appendChild(menu);
  // Keep it on-screen.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - r.height - 8))}px`;
  menu.querySelector<HTMLElement>(".context-menu-item")?.focus();

  const close = (e: Event) => {
    if (!menu.contains(e.target as Node)) dismiss();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
    }
  };
  const dismiss = () => {
    menu.remove();
    window.removeEventListener("mousedown", close, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", dismiss);
  };
  setTimeout(() => window.addEventListener("mousedown", close, true), 0);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", dismiss);
}

/** One rendered row, in visual order — the model for keyboard navigation. */
interface Row {
  path: string;
  isDir: boolean;
  depth: number;
  parent: string;
}

export class FileTree {
  private root: string | null = null;
  private expanded = new Set<string>();
  private children = new Map<string, Entry[]>();
  private selected: string | null = null;
  private renamingPath: string | null = null;
  private rows: Row[] = [];
  /** Row that owns the roving tabindex. */
  private focusPath: string | null = null;
  /** git state per file, plus the worst state rolled up onto each folder. */
  private git = new Map<string, GitStatus>();
  private gitDirs = new Map<string, GitStatus>();

  constructor(
    private container: HTMLElement,
    private backend: Backend,
    private cb: TreeCallbacks,
  ) {
    // Dropping on empty tree space moves the item to the workspace root.
    container.addEventListener("dragover", (e) => {
      if (e.target === container && e.dataTransfer?.types.includes(TREE_MOVE_DND)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
    });
    container.addEventListener("drop", (e) => {
      const src = e.dataTransfer?.getData(TREE_MOVE_DND);
      if (e.target === container && src && this.root) {
        e.preventDefault();
        this.cb.onMove(src, this.root);
      }
    });
    container.addEventListener("contextmenu", (e) => {
      if (e.target !== container) return; // row handlers cover their own rows
      e.preventDefault();
      if (this.root) this.rootMenu(e.clientX, e.clientY, this.root);
    });
    container.addEventListener("keydown", (e) => this.onKeyDown(e));
  }

  async setRoot(path: string, expanded: string[] = []) {
    this.root = path;
    this.expanded = new Set(expanded.filter((p) => isUnder(p, path)));
    this.children.clear();
    this.selected = null;
    this.focusPath = null;
    this.renamingPath = null;
    await this.load(path);
    // Restore previously open folders (breadth-first so parents load first).
    for (const dir of [...this.expanded].sort((a, b) => a.length - b.length)) {
      if (!this.children.has(dir)) await this.load(dir);
    }
    this.render();
  }

  get expandedDirs(): string[] {
    return [...this.expanded];
  }

  /** Apply a git status snapshot (null = not a repository → clear the marks).
      Folder marks are rolled up from their descendants, worst state winning. */
  setGit(info: GitInfo | null) {
    this.git = new Map();
    this.gitDirs = new Map();
    for (const e of info?.entries ?? []) {
      this.git.set(e.path, e.status);
      // Propagate up to (but not past) the workspace root.
      const stop = this.root;
      let dir = parentOf(e.path);
      while (dir && (!stop || isUnder(dir, stop))) {
        const cur = this.gitDirs.get(dir);
        if (!cur || GIT_RANK[e.status] > GIT_RANK[cur]) this.gitDirs.set(dir, e.status);
        if (dir === stop) break;
        const next = parentOf(dir);
        if (next === dir) break;
        dir = next;
      }
    }
    // Decorations never add or remove rows, so patch them in place: a full
    // rebuild here (this fires on every save) would destroy an in-progress
    // drag and yank the keyboard focus around.
    this.patchGitBadges();
  }

  /** Re-apply git decorations to the already-rendered rows. */
  private patchGitBadges() {
    for (const r of this.rows) {
      if (this.renamingPath === r.path) continue; // input row has no badge slot
      const row = this.rowEl(r.path);
      if (!row) continue;
      const status = r.isDir
        ? worse(this.gitDirs.get(r.path), this.git.get(r.path))
        : this.git.get(r.path);
      row.classList.remove(
        "git",
        ...(Object.keys(GIT_BADGE) as GitStatus[]).map((s) => `git-${s}`),
      );
      row.querySelector(".git-badge")?.remove();
      if (status) {
        row.classList.add("git", `git-${status}`);
        const badge = document.createElement("span");
        badge.className = "git-badge";
        badge.textContent = r.isDir ? "" : GIT_BADGE[status];
        badge.title = r.isDir
          ? `Contains ${GIT_LABEL[status].toLowerCase()} files`
          : GIT_LABEL[status];
        row.appendChild(badge);
      }
    }
  }

  /** Re-read a directory (e.g. after creating a file) and re-render. */
  async refreshDir(path: string) {
    if (this.children.has(path)) await this.load(path);
    this.render();
  }

  /** Re-read every directory we've loaded — used after bulk external changes. */
  async refreshAll() {
    await Promise.all([...this.children.keys()].map((d) => this.load(d)));
    this.render();
  }

  /** Refresh only the directories affected by an external change. */
  async refreshDirs(dirs: string[]) {
    const mine = dirs.filter((d) => this.children.has(d));
    if (!mine.length) return;
    await Promise.all(mine.map((d) => this.load(d)));
    this.render();
  }

  select(path: string | null) {
    this.selected = path;
    if (path) this.focusPath = path;
    this.render();
  }

  /** Expand every ancestor of `path`, load them, and select it. */
  async reveal(path: string) {
    if (!this.root || !isUnder(path, this.root)) return;
    const parts = path.slice(this.root.length).split("/").filter(Boolean);
    let cur = this.root;
    let changed = false;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = `${cur}/${parts[i]}`;
      if (!this.expanded.has(cur)) {
        this.expanded.add(cur);
        changed = true;
      }
      if (!this.children.has(cur)) await this.load(cur);
    }
    this.selected = path;
    this.focusPath = path;
    this.render();
    if (changed) this.cb.onExpandedChange?.(this.expandedDirs);
    this.container
      .querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  /** Put a freshly created/selected entry straight into rename mode. */
  startRename(path: string) {
    this.renamingPath = path;
    this.render();
  }

  private async load(dir: string) {
    try {
      this.children.set(dir, await this.backend.listDir(dir));
    } catch {
      this.children.set(dir, []);
    }
  }

  private async toggle(dir: string) {
    if (this.expanded.has(dir)) {
      this.expanded.delete(dir);
    } else {
      this.expanded.add(dir);
      if (!this.children.has(dir)) await this.load(dir);
    }
    this.render();
    this.cb.onExpandedChange?.(this.expandedDirs);
  }

  private render() {
    const hadFocus = this.container.contains(document.activeElement);
    const scrollTop = this.container.scrollTop;
    this.container.innerHTML = "";
    this.rows = [];
    if (!this.root) return;
    const frag = document.createDocumentFragment();
    this.renderLevel(frag, this.root, 0);
    this.container.appendChild(frag);
    // A rebuild momentarily collapses the content to zero height, which
    // clamps the scroll — put it back where the user left it.
    this.container.scrollTop = scrollTop;
    // Keep the roving tabindex pointing at something that still exists.
    if (!this.rows.some((r) => r.path === this.focusPath)) {
      this.focusPath = this.rows[0]?.path ?? null;
    }
    const focusRow = this.rowEl(this.focusPath);
    if (focusRow) focusRow.tabIndex = 0;
    else if (this.rows.length === 0) this.container.tabIndex = 0;
    if (hadFocus && this.renamingPath === null) focusRow?.focus({ preventScroll: true });
  }

  private rowEl(path: string | null): HTMLElement | null {
    if (!path) return null;
    return this.container.querySelector<HTMLElement>(
      `[data-path="${CSS.escape(path)}"]`,
    );
  }

  private renderLevel(parent: Node, dir: string, depth: number) {
    const entries = this.children.get(dir) ?? [];
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "tree-row" + (entry.path === this.selected ? " selected" : "");
      row.style.paddingLeft = `${10 + depth * 14}px`;
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(depth + 1));
      row.setAttribute("aria-selected", String(entry.path === this.selected));
      row.dataset.path = entry.path;
      row.tabIndex = -1;
      row.title = entry.name;
      this.rows.push({ path: entry.path, isDir: entry.is_dir, depth, parent: dir });

      const icon = entry.is_dir ? FOLDER_ICON : fileIcon(entry.name);
      const lead = entry.is_dir ? CHEVRON : `<span class="chevron-spacer"></span>`;

      if (this.renamingPath === entry.path) {
        row.innerHTML = `${lead}${icon}`;
        row.appendChild(this.renameInput(entry));
        parent.appendChild(row);
        continue;
      }

      row.innerHTML = `${lead}${icon}<span class="row-name"></span>`;
      row.querySelector(".row-name")!.textContent = entry.is_dir
        ? entry.name
        : entry.name.replace(/\.(md|markdown)$/i, "");

      // Git decoration: a letter on files, a dot on folders that contain them.
      // A directory can also be an entry in its own right (git reports dirty
      // submodules that way), so take the worse of the two.
      const status = entry.is_dir
        ? worse(this.gitDirs.get(entry.path), this.git.get(entry.path))
        : this.git.get(entry.path);
      if (status) {
        row.classList.add("git", `git-${status}`);
        const badge = document.createElement("span");
        badge.className = "git-badge";
        badge.textContent = entry.is_dir ? "" : GIT_BADGE[status];
        badge.title = entry.is_dir
          ? `Contains ${GIT_LABEL[status].toLowerCase()} files`
          : GIT_LABEL[status];
        row.appendChild(badge);
      }

      if (entry.is_dir) {
        const open = this.expanded.has(entry.path);
        row.setAttribute("aria-expanded", String(open));
        if (open) row.classList.add("open");
      }

      this.wireRow(row, entry);
      parent.appendChild(row);

      if (entry.is_dir && this.expanded.has(entry.path)) {
        this.renderLevel(parent, entry.path, depth + 1);
      }
    }
    if (depth === 0 && entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.innerHTML = `<p>Nothing here yet.</p>`;
      const btn = document.createElement("button");
      btn.className = "btn-quiet";
      btn.textContent = "New markdown file";
      btn.addEventListener("click", () => this.root && this.cb.onNewFile(this.root));
      empty.appendChild(btn);
      parent.appendChild(empty);
    }
  }

  private activate(entry: { path: string; is_dir: boolean }) {
    if (entry.is_dir) {
      void this.toggle(entry.path);
    } else {
      this.selected = entry.path;
      this.focusPath = entry.path;
      this.render();
      this.cb.onOpenFile(entry.path);
    }
  }

  private wireRow(row: HTMLDivElement, entry: Entry) {
    row.addEventListener("click", () => {
      this.focusPath = entry.path;
      this.activate(entry);
    });
    row.addEventListener("dblclick", (e) => {
      e.preventDefault();
      this.startRename(entry.path);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.rowMenu(e.clientX, e.clientY, entry);
    });
    row.addEventListener("focus", () => {
      this.focusPath = entry.path;
    });

    // Every row can be dragged to move it; images also feed the editor.
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData(TREE_MOVE_DND, entry.path);
      e.dataTransfer?.setData("text/plain", entry.name);
      if (!entry.is_dir && IMG_RE.test(entry.name)) {
        e.dataTransfer?.setData(TREE_IMAGE_DND, entry.path);
      }
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
    });

    if (entry.is_dir) {
      // Folders accept dropped items (move into).
      row.addEventListener("dragover", (e) => {
        const t = e.dataTransfer;
        if (!t?.types.includes(TREE_MOVE_DND)) return;
        e.preventDefault();
        e.stopPropagation();
        t.dropEffect = "move";
        row.classList.add("drop-target");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
      row.addEventListener("drop", (e) => {
        row.classList.remove("drop-target");
        const src = e.dataTransfer?.getData(TREE_MOVE_DND);
        if (!src || src === entry.path) return;
        e.preventDefault();
        e.stopPropagation();
        this.cb.onMove(src, entry.path);
      });
    }
  }

  // ------------------------------------------------------- keyboard support

  private focusRow(path: string) {
    this.focusPath = path;
    for (const el of this.container.querySelectorAll<HTMLElement>(".tree-row")) {
      el.tabIndex = el.dataset.path === path ? 0 : -1;
    }
    const el = this.rowEl(path);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  }

  private onKeyDown(e: KeyboardEvent) {
    if (this.renamingPath) return; // the rename input owns the keyboard
    // Trust the DOM first: focus can move without a focus event reaching us
    // (programmatic focus while the window is in the background).
    const active = (document.activeElement as HTMLElement | null)?.dataset?.path;
    if (active && this.rows.some((r) => r.path === active)) this.focusPath = active;
    const idx = this.rows.findIndex((r) => r.path === this.focusPath);
    const row = idx >= 0 ? this.rows[idx] : null;
    const move = (to: number) => {
      const next = this.rows[Math.max(0, Math.min(this.rows.length - 1, to))];
      if (next) this.focusRow(next.path);
    };
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(idx + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(idx - 1);
        break;
      case "Home":
        e.preventDefault();
        move(0);
        break;
      case "End":
        e.preventDefault();
        move(this.rows.length - 1);
        break;
      case "ArrowRight":
        if (!row) break;
        e.preventDefault();
        if (row.isDir && !this.expanded.has(row.path)) void this.toggle(row.path);
        else if (row.isDir) move(idx + 1);
        break;
      case "ArrowLeft": {
        if (!row) break;
        e.preventDefault();
        if (row.isDir && this.expanded.has(row.path)) void this.toggle(row.path);
        else if (row.parent !== this.root) this.focusRow(row.parent);
        break;
      }
      case "Enter":
      case " ":
        if (!row) break;
        e.preventDefault();
        this.activate({ path: row.path, is_dir: row.isDir });
        break;
      case "F2":
        if (!row) break;
        e.preventDefault();
        this.startRename(row.path);
        break;
      case "Backspace":
      case "Delete":
        if (!row) break;
        // ⌘⌫ only (the Finder convention). A bare Backspace is far too often
        // a mistyped edit to answer with a "move to Trash?" dialog — and on a
        // folder row it would offer to trash a whole subtree.
        if (!e.metaKey && !e.ctrlKey) break;
        e.preventDefault();
        this.cb.onDelete(row.path, row.isDir);
        break;
      default:
        return;
    }
  }

  private renameInput(entry: Entry): HTMLInputElement {
    const input = document.createElement("input");
    input.className = "rename-input";
    input.value = entry.name;
    input.spellcheck = false;
    input.setAttribute("aria-label", "New name");
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      this.renamingPath = null;
      if (name && name !== entry.name) this.cb.onRename(entry.path, name);
      else this.render();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      this.renamingPath = null;
      this.render();
      this.focusRow(entry.path);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // don't drive tree navigation while typing
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
    input.addEventListener("blur", commit);
    // Focus after it lands in the DOM; select the stem (keep the extension).
    setTimeout(() => {
      input.focus();
      const dot = entry.is_dir ? -1 : entry.name.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
    }, 0);
    return input;
  }

  private async duplicate(path: string) {
    const parent = parentOf(path);
    try {
      const created = await this.backend.duplicatePath(path);
      await this.refreshDir(parent);
      await this.reveal(created);
      toast(`Duplicated as “${baseOf(created)}”`);
    } catch (e) {
      toastError("Couldn’t duplicate", e);
    }
  }

  private rowMenu(x: number, y: number, entry: Entry) {
    this.selected = entry.path;
    this.focusPath = entry.path;
    this.render();
    const parentDir = entry.is_dir ? entry.path : parentOf(entry.path);
    const items: (MenuItem | "-")[] = [];
    if (!entry.is_dir) {
      items.push({
        label: "Open in Default App",
        action: () =>
          void this.backend
            .openPath(entry.path)
            .catch((e) => toastError("Couldn’t open", e)),
      });
    }
    const git = entry.is_dir ? undefined : this.git.get(entry.path);
    if (git && git !== "deleted") {
      items.push({
        label: "Show Changes",
        action: () => this.cb.onShowDiff(entry.path),
      });
    }
    if (git && git !== "conflict") {
      items.push({
        label: "Discard Changes…",
        danger: true,
        action: () => this.cb.onDiscard(entry.path, git),
      });
    }
    if (git) items.push("-");
    items.push(
      { label: "New File", action: () => this.cb.onNewFile(parentDir) },
      { label: "New Folder", action: () => this.cb.onNewFolder(parentDir) },
      "-",
      { label: "Rename", hint: "F2", action: () => this.startRename(entry.path) },
      { label: "Duplicate", action: () => void this.duplicate(entry.path) },
      "-",
      {
        label: "Reveal in Finder",
        action: () =>
          void this.backend
            .revealPath(entry.path)
            .catch((e) => toastError("Couldn’t reveal", e)),
      },
      {
        label: "Copy Path",
        action: () =>
          void copyText(entry.path)
            .then(() => toast("Path copied"))
            .catch(() => toast("Couldn’t copy path", { kind: "error" })),
      },
      "-",
      {
        label: entry.is_dir ? "Delete Folder" : "Delete",
        // The only place ⌘⌫ is discoverable — a bare Backspace used to do
        // this, and nothing else announces that it no longer does.
        hint: "⌘⌫",
        danger: true,
        action: () => this.cb.onDelete(entry.path, entry.is_dir),
      },
    );
    showContextMenu(x, y, items);
  }

  /** `root` is passed in because the caller has already established there is
      one — re-checking here would be an unreachable branch. */
  private rootMenu(x: number, y: number, root: string) {
    showContextMenu(x, y, [
      { label: "New File", action: () => this.cb.onNewFile(root) },
      { label: "New Folder", action: () => this.cb.onNewFolder(root) },
      "-",
      {
        label: "Reveal in Finder",
        action: () =>
          void this.backend.revealPath(root).catch((e) => toastError("Couldn’t reveal", e)),
      },
      {
        label: "Copy Path",
        action: () =>
          void copyText(root)
            .then(() => toast("Path copied"))
            .catch(() => toast("Couldn’t copy path", { kind: "error" })),
      },
    ]);
  }
}
