import "./styles.css";
import {
  createBackend,
  isTauri,
  LIST_CAP,
  type GitStatus,
  type SearchHit,
  type SearchOptions,
} from "./backend";
import { FileTree, fileIcon, showContextMenu, GIT_LABEL } from "./tree";
import { TAB_DND } from "./dnd";
import { diffStat as diffStat_, parseDiff } from "./diff";
import {
  IMG_RE,
  MD_RE,
  baseOf,
  displayName,
  escapeHtml,
  isUnder,
  parentOf,
  remapPath,
  resolveLink,
} from "./paths";
import {
  clampScale,
  clearSession,
  loadSession,
  saveSession as persistSession,
  sessionKey,
  usableTabs,
  type Session,
} from "./session";
import { MarkdownEditor, type SaveState, type EditorMode } from "./editor";
import { resolveKey } from "./keys";
import { CommandPalette, ICON_COMMAND, ICON_HEADING } from "./palette";
import { toast, toastError } from "./toast";
import { checkForUpdates } from "./updater";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

/** Sentinel path for the single unsaved draft tab. */
const DRAFT = "mad://draft";

interface Tab {
  path: string;
  kind: "md" | "img";
  draft?: boolean;
}

async function init() {
  const backend = await createBackend();
  if (isTauri) document.body.classList.add("tauri");
  // Every window has its own workspace, tabs and session; localStorage is
  // shared, so the label is what keeps them apart.
  const winLabel = isTauri
    ? (await import("@tauri-apps/api/window")).getCurrentWindow().label
    : "main";
  const isMainWindow = winLabel === "main";
  const SESSION = sessionKey(winLabel);
  const saved = loadSession(localStorage, SESSION);

  const welcome = $("welcome");
  const editorEl = $("editor");
  const folderNameEl = $("folder-name");
  const saveStatus = $("save-status");
  const saveStatusText = $("save-status-text");
  const sidebarEmpty = $("sidebar-empty");
  const treeEl = $("tree");
  const tabsEl = $("tabs");
  const modeToggle = $("mode-toggle");
  const imageViewer = $("image-viewer");
  const imageViewerImg = $<HTMLImageElement>("image-viewer-img");
  const imageMeta = $("image-meta");
  const statusPath = $("status-path");
  const statusStats = $("status-stats");
  const statusCursor = $("status-cursor");

  let rootPath: string | null = null;
  let tabs: Tab[] = [];
  let activePath: string | null = null;
  /** The draft's content while it isn't the live editor document. */
  let draftBuffer = "";
  let saveState: SaveState = "saved";
  /** git status per absolute path, mirrored onto tabs as well as the tree. */
  let gitMap = new Map<string, GitStatus>();
  let docScale = clampScale(saved.scale);

  // ------------------------------------------------------------- session

  let sessionTimer: ReturnType<typeof setTimeout> | undefined;
  const buildSession = (): Session => ({
    root: rootPath,
    tabs: tabs.filter((t) => !t.draft).map((t) => t.path),
    active: activePath === DRAFT ? null : activePath,
    expanded: tree.expandedDirs,
    sidebarHidden: document.body.classList.contains("sidebar-hidden"),
    scale: docScale,
    sidebarWidth: sidebar.style.width || null,
  });
  const saveSession = () => {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(
      () => persistSession(localStorage, buildSession(), SESSION),
      250,
    );
  };

  const setSaveState = (state: SaveState) => {
    saveState = state;
    saveStatus.classList.remove("hidden", "saved", "edited", "saving", "unsaved");
    saveStatus.classList.add(state);
    saveStatusText.textContent =
      state === "saved"
        ? "Saved"
        : state === "saving"
          ? "Saving…"
          : state === "unsaved"
            ? "Unsaved"
            : "Edited";
    updateTabDirt();
    // A completed write changes the file's git state.
    if (state === "saved") refreshGit();
  };

  const setModeUI = (mode: EditorMode) => {
    for (const btn of modeToggle.querySelectorAll("button")) {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    }
    updateStatus();
  };

  const editor = new MarkdownEditor(
    editorEl,
    backend,
    setSaveState,
    setModeUI,
    (dir) => void tree.refreshDir(dir), // show pasted/dropped images in the tree
    () => updateStatus(),
  );

  const activeTab = () => tabs.find((t) => t.path === activePath) ?? null;

  const tabLabel = (tab: Tab) =>
    tab.draft
      ? "Untitled"
      : tab.kind === "img"
        ? baseOf(tab.path)
        : displayName(tab.path);

  const hasUnsavedDraft = () => {
    if (!tabs.some((t) => t.draft)) return false;
    const content = activePath === DRAFT ? editor.getContent() : draftBuffer;
    return content.trim().length > 0;
  };

  // Keep the state-gated native menu items truthful: doc-scoped items need an
  // active markdown document, tab-scoped need any tab, folder-scoped need an
  // open workspace.
  const updateMenuState = () => {
    const t = activeTab();
    void backend.setMenuState(!!t && t.kind === "md", !!t, !!rootPath);
  };

  // -------------------------------------------------------------- status bar

  const nf = new Intl.NumberFormat();
  // Coalesce to one repaint per frame — this fires on every keystroke.
  let statusQueued = false;
  const updateStatus = () => {
    if (statusQueued) return;
    statusQueued = true;
    requestAnimationFrame(() => {
      statusQueued = false;
      renderStatus();
    });
  };
  const renderStatus = () => {
    const t = activeTab();
    if (!t) {
      statusPath.textContent = "";
      statusStats.textContent = "";
      statusCursor.textContent = "";
      return;
    }
    statusPath.textContent = t.draft
      ? "Untitled — not saved yet"
      : rootPath && t.path.startsWith(rootPath + "/")
        ? t.path.slice(rootPath.length + 1)
        : t.path;
    statusPath.title = t.draft ? "" : t.path;
    if (t.kind === "img") {
      statusStats.textContent = "";
      statusCursor.textContent = "";
      return;
    }
    // Separate spans so narrow windows can drop the least important parts.
    const s = editor.getStats();
    statusStats.innerHTML =
      `<span class="st-words"></span><span class="st-chars"></span><span class="st-read"></span>`;
    statusStats.querySelector(".st-words")!.textContent =
      `${nf.format(s.words)} word${s.words === 1 ? "" : "s"}`;
    statusStats.querySelector(".st-chars")!.textContent =
      `${nf.format(s.chars)} char${s.chars === 1 ? "" : "s"}`;
    statusStats.querySelector(".st-read")!.textContent = s.readingMinutes
      ? `${s.readingMinutes} min read`
      : "";
    statusCursor.textContent = s.cursor
      ? `Ln ${s.cursor.line}, Col ${s.cursor.col}`
      : "";
  };

  // -------------------------------------------------------------- tab strip

  /** Only the active document can hold unsaved changes; reflect it live. */
  const updateTabDirt = () => {
    const dirty = saveState === "edited" || saveState === "unsaved";
    for (const el of tabsEl.querySelectorAll<HTMLElement>(".tab")) {
      el.classList.toggle("dirty", dirty && el.dataset.path === activePath);
    }
  };

  const moveTab = (srcPath: string, destPath: string, before: boolean) => {
    if (srcPath === destPath) return;
    const from = tabs.findIndex((t) => t.path === srcPath);
    if (from < 0) return;
    const [moved] = tabs.splice(from, 1);
    let to = tabs.findIndex((t) => t.path === destPath);
    if (to < 0) to = tabs.length;
    else if (!before) to += 1;
    tabs.splice(to, 0, moved);
    renderTabs();
    saveSession();
  };

  const renderTabs = () => {
    tabsEl.innerHTML = "";
    for (const tab of tabs) {
      const el = document.createElement("div");
      const git = tab.draft ? undefined : gitMap.get(tab.path);
      el.className =
        "tab" +
        (tab.path === activePath ? " active" : "") +
        (tab.draft ? " draft" : "") +
        (git ? ` git git-${git}` : "");
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", String(tab.path === activePath));
      // Roving tabindex: the active tab joins the tab order; arrows move
      // focus within the strip (wired once on tabsEl below).
      el.tabIndex = tab.path === activePath ? 0 : -1;
      el.dataset.path = tab.path;
      el.draggable = true;
      el.title = tab.draft
        ? "Untitled (unsaved)"
        : git
          ? `${tab.path}\n${GIT_LABEL[git]}`
          : tab.path;
      el.innerHTML =
        fileIcon(tab.draft ? "untitled.md" : tab.path) +
        `<span class="tab-name"></span>` +
        `<span class="tab-dot" aria-hidden="true"></span>` +
        `<button class="tab-close" tabindex="-1">` +
        `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg></button>`;
      el.querySelector(".tab-name")!.textContent = tabLabel(tab);
      el.querySelector(".tab-close")!.setAttribute("aria-label", `Close ${tabLabel(tab)}`);
      el.addEventListener("mousedown", (e) => {
        if (e.button === 1) {
          e.preventDefault();
          void closeTab(tab.path);
        }
      });
      el.addEventListener("click", (e) => {
        if ((e.target as Element).closest(".tab-close")) return;
        void activate(tab.path);
      });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        tabMenu(e.clientX, e.clientY, tab);
      });
      el.querySelector(".tab-close")!.addEventListener("click", (e) => {
        e.stopPropagation();
        void closeTab(tab.path);
      });

      // Drag to reorder.
      el.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData(TAB_DND, tab.path);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        el.classList.add("dragging");
      });
      el.addEventListener("dragend", () => el.classList.remove("dragging"));
      const edge = (e: DragEvent) => {
        const r = el.getBoundingClientRect();
        return e.clientX < r.left + r.width / 2;
      };
      el.addEventListener("dragover", (e) => {
        if (!e.dataTransfer?.types.includes(TAB_DND)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const before = edge(e);
        el.classList.toggle("drop-before", before);
        el.classList.toggle("drop-after", !before);
      });
      el.addEventListener("dragleave", () =>
        el.classList.remove("drop-before", "drop-after"),
      );
      el.addEventListener("drop", (e) => {
        const src = e.dataTransfer?.getData(TAB_DND);
        el.classList.remove("drop-before", "drop-after");
        if (!src) return;
        e.preventDefault();
        e.stopPropagation();
        moveTab(src, tab.path, edge(e));
      });

      tabsEl.appendChild(el);
    }
    updateTabDirt();
    tabsEl
      .querySelector<HTMLElement>(".tab.active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  // One context-menu implementation for the whole app: the shared one knows
  // about Escape, blur dismissal, clamping and menu roles.
  const tabMenu = (x: number, y: number, tab: Tab) => {
    showContextMenu(x, y, [
      { label: "Close", action: () => void closeTab(tab.path) },
      {
        label: "Close Others",
        disabled: tabs.length < 2,
        action: () =>
          void closeMany(tabs.filter((t) => t.path !== tab.path).map((t) => t.path)),
      },
      { label: "Close All", action: () => void closeMany(tabs.map((t) => t.path)) },
      ...(tab.draft
        ? []
        : ([
            "-",
            {
              label: "Reveal in Finder",
              action: () =>
                void backend
                  .revealPath(tab.path)
                  .catch((e) => toastError("Couldn’t reveal", e)),
            },
            {
              label: "Copy Path",
              action: () =>
                void navigator.clipboard
                  .writeText(tab.path)
                  .then(() => toast("Path copied"))
                  .catch(() => toast("Couldn’t copy path", { kind: "error" })),
            },
          ] as const)),
    ]);
  };

  // Keyboard access for the tab strip: Left/Right/Home/End move focus,
  // Enter/Space activate, ⌫ closes. Without this the tablist announced tabs
  // that nothing could reach.
  tabsEl.addEventListener("keydown", (e) => {
    const els = [...tabsEl.querySelectorAll<HTMLElement>(".tab")];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const focus = (j: number) => els[Math.max(0, Math.min(j, els.length - 1))]?.focus();
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        focus(i + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        focus(i - 1);
        break;
      case "Home":
        e.preventDefault();
        focus(0);
        break;
      case "End":
        e.preventDefault();
        focus(els.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        void activate(els[i].dataset.path!);
        break;
      case "Backspace":
      case "Delete":
        e.preventDefault();
        void closeTab(els[i].dataset.path!);
        break;
    }
  });

  const showSurface = (which: "welcome" | "editor" | "image") => {
    const isEditor = which === "editor";
    welcome.classList.toggle("hidden", which !== "welcome");
    editorEl.classList.toggle("hidden", !isEditor);
    imageViewer.classList.toggle("hidden", which !== "image");
    if (which !== "image") {
      // Release the (possibly multi-MB) data URL instead of holding it for
      // the rest of the session.
      imageViewerImg.onload = null;
      imageViewerImg.onerror = null;
      imageViewerImg.removeAttribute("src");
    }
    modeToggle.classList.toggle("hidden", !isEditor || editor.isSplit);
    $("btn-split").classList.toggle("hidden", !isEditor);
    if (!isEditor) saveStatus.classList.add("hidden");
    if (which !== "editor") closeFind();
    closeDiff();
  };

  /** Monotonic ticket for activations: slow async work (an image decode, a
      file read) must never overwrite the state of a newer activation. */
  let activateSeq = 0;

  /** Make `path` the active view (its tab must already exist).
      Resolves true when the tab actually became active. */
  const activate = async (path: string): Promise<boolean> => {
    const tab = tabs.find((t) => t.path === path);
    if (!tab) return false;
    const seq = ++activateSeq;

    // Re-activating the already-visible tab: just show it.
    if (activePath === path && (tab.draft || tab.kind === "img" || editor.path === path)) {
      showSurface(tab.kind === "img" ? "image" : "editor");
      return true;
    }

    // Preserve the unsaved draft's content before we leave it.
    if (activePath === DRAFT && editor.isDraft) draftBuffer = editor.getContent();

    if (tab.draft) {
      if (!(await editor.openDraft(draftBuffer))) {
        tree.select(editor.path);
        return false;
      }
      if (seq !== activateSeq) return false; // superseded while loading
      activePath = DRAFT;
      showSurface("editor");
      tree.select(null);
      renderTabs();
      updateMenuState();
      updateStatus();
      saveSession();
      return true;
    }

    if (tab.kind === "img") {
      await editor.flush();
      let url: string;
      try {
        url = await backend.toDisplayUrl(path);
      } catch (e) {
        toastError("Couldn’t open image", e);
        await closeTab(path);
        return false;
      }
      if (seq !== activateSeq) return false; // a newer activation won
      imageMeta.textContent = baseOf(path);
      imageViewerImg.onload = () => {
        imageMeta.textContent = `${baseOf(path)} · ${imageViewerImg.naturalWidth}×${imageViewerImg.naturalHeight}`;
      };
      imageViewerImg.onerror = () => {
        imageMeta.textContent = `${baseOf(path)} — couldn’t be displayed`;
        toast(`“${baseOf(path)}” doesn’t look like a valid image.`, {
          kind: "error",
        });
      };
      imageViewerImg.src = url;
      activePath = path;
      showSurface("image");
      tree.select(path);
      renderTabs();
      updateMenuState();
      updateStatus();
      saveSession();
      return true;
    }

    try {
      if (!(await editor.openFile(path))) {
        tree.select(editor.path); // save blocked — stay on the current file
        return false;
      }
    } catch (e) {
      toastError(`Couldn’t open ${baseOf(path)}`, e);
      await closeTab(path);
      return false;
    }
    if (seq !== activateSeq) return false; // superseded while loading
    activePath = path;
    showSurface("editor");
    tree.select(path);
    renderTabs();
    updateMenuState();
    updateStatus();
    saveSession();
    return true;
  };

  /** Open a file: create its tab if needed, then activate it. */
  const openFile = async (path: string): Promise<boolean> => {
    if (!tabs.some((t) => t.path === path)) {
      tabs.push({ path, kind: IMG_RE.test(path) ? "img" : "md" });
    }
    return activate(path);
  };

  const goWelcome = () => {
    activePath = null;
    // Nothing is shown, so nothing may keep reacting to fs events or flushes.
    editor.detach();
    showSurface("welcome");
    tree.select(null);
    updateMenuState();
    updateStatus();
    saveSession();
  };

  /** After a flush, is the buffer safely on disk (or nothing left to save)? */
  const ensureSaved = async (): Promise<boolean> => {
    await editor.flush(); // reports its own errors
    return !editor.path || !editor.hasUnsavedChanges;
  };

  const closeTab = async (path: string) => {
    const idx = tabs.findIndex((t) => t.path === path);
    if (idx < 0) return;
    const tab = tabs[idx];
    if (tab.draft) {
      const content = activePath === DRAFT ? editor.getContent() : draftBuffer;
      if (
        content.trim() &&
        !(await backend.confirm(
          "Discard unsaved file",
          "This file has never been saved. Discard it?",
        ))
      ) {
        return;
      }
      draftBuffer = "";
      if (activePath === DRAFT) editor.detach();
    }
    if (activePath !== path) {
      tabs.splice(idx, 1);
      renderTabs();
      saveSession();
      return;
    }
    // The active document must be safely on disk before its tab disappears —
    // a failed save keeps the tab (and with it the retry path) alive.
    if (tab.kind === "md" && !tab.draft && !(await ensureSaved())) return;
    if (editor.path === path) editor.detach();
    tabs.splice(idx, 1);
    if (tabs.length === 0) {
      goWelcome();
      renderTabs();
      return;
    }
    await activate(tabs[Math.min(idx, tabs.length - 1)].path);
    if (activePath === path) {
      // The neighbour failed to open (its tab closed itself). Show whatever
      // is left rather than pointing at the tab we just closed.
      if (tabs.length) await activate(tabs[tabs.length - 1].path);
      if (activePath === path) goWelcome();
    }
    renderTabs(); // even if activation failed, the strip must match `tabs`
    saveSession();
  };

  /** Close a set of tabs in one step — no per-tab reload of soon-dead files. */
  const closeMany = async (paths: string[]) => {
    const set = new Set(paths);
    // The draft has its own confirmation flow — route it through closeTab.
    if (tabs.some((t) => t.draft && set.has(t.path))) await closeTab(DRAFT);
    const keep = tabs.filter((t) => t.draft || !set.has(t.path));
    if (keep.length === tabs.length) return;
    const closingActive =
      activePath !== null && !keep.some((t) => t.path === activePath);
    // Whatever document the editor holds, persist it before its tab vanishes.
    if (editor.path && !keep.some((t) => t.path === editor.path)) {
      if (!(await ensureSaved())) return; // a failed save leaves every tab open
      editor.detach();
    }
    tabs = keep;
    if (closingActive) {
      if (tabs.length) await activate(tabs[tabs.length - 1].path);
      // Activation can fail (unreadable file closes its own tab) — never
      // leave activePath pointing at something that no longer has a tab.
      if (activePath !== null && !tabs.some((t) => t.path === activePath)) {
        goWelcome();
      }
    }
    renderTabs();
    saveSession();
  };

  /** Close every tab under `path` (used after a move/delete invalidates it). */
  const closeTabsUnder = async (path: string) => {
    const hit = (p: string) => isUnder(p, path);
    if (!tabs.some((t) => hit(t.path))) return;
    const wasActive = activePath !== null && hit(activePath);
    tabs = tabs.filter((t) => !hit(t.path));
    if (wasActive) {
      if (tabs.length) await activate(tabs[tabs.length - 1].path);
      else goWelcome();
    }
    renderTabs();
    saveSession();
  };

  /** After an on-disk rename/move of `oldPath` → `newPath`, fix open state. */
  const remapPaths = (oldPath: string, newPath: string) => {
    const remap = (p: string) => remapPath(p, oldPath, newPath);
    for (const t of tabs) if (!t.draft) t.path = remap(t.path);
    if (activePath) activePath = remap(activePath);
    const ep = editor.path;
    if (ep && isUnder(ep, oldPath)) {
      editor.adoptPath(remap(ep));
    }
  };

  // ---------------------------------------------------------- tree callbacks

  const onRename = async (oldPath: string, rawName: string) => {
    let name = rawName.trim();
    // Reject path separators / traversal so a rename can't relocate the file.
    if (!name || /[/\\]/.test(name) || name === "." || name === "..") {
      toast("A name can’t contain slashes.", { kind: "error" });
      await tree.refreshDir(parentOf(oldPath));
      return;
    }
    // Add `.md` only when no extension was typed at all — someone renaming
    // `notes.md` to `notes.txt` means it, and `notes.txt.md` helps nobody.
    if (MD_RE.test(oldPath) && !/\.[^./]+$/.test(name)) name += ".md";
    const newPath = `${parentOf(oldPath)}/${name}`;
    if (newPath === oldPath) return;
    await editor.flush(); // no pending autosave should race the on-disk move
    try {
      await backend.renamePath(oldPath, newPath);
    } catch (e) {
      toastError("Couldn’t rename", e);
      await tree.refreshDir(parentOf(oldPath));
      return;
    }
    remapPaths(oldPath, newPath);
    await tree.refreshDir(parentOf(oldPath));
    await tree.reveal(newPath);
    renderTabs();
    updateStatus();
    refreshGit();
    saveSession();
  };

  const onMove = async (src: string, destDir: string) => {
    if (parentOf(src) === destDir) return;
    if (destDir === src || destDir.startsWith(src + "/")) return; // into itself
    await editor.flush(); // no pending autosave should race the on-disk move
    let newPath: string;
    try {
      newPath = await backend.moveInto(src, destDir);
    } catch (e) {
      toastError("Couldn’t move", e);
      return;
    }
    remapPaths(src, newPath);
    await tree.refreshDir(parentOf(src));
    await tree.refreshDir(destDir);
    await tree.reveal(newPath);
    renderTabs();
    updateStatus();
    refreshGit();
    saveSession();
  };

  const onNewFileIn = async (dir: string) => {
    let created: string;
    try {
      created = await backend.createFile(dir, "Untitled.md");
    } catch (e) {
      toastError("Couldn’t create file", e);
      return;
    }
    await tree.refreshDir(dir);
    refreshGit();
    await openFile(created);
    tree.startRename(created);
  };

  const onNewFolder = async (dir: string) => {
    if (!dir) {
      toast("Open a folder first.", { kind: "error" });
      return;
    }
    let created: string;
    try {
      created = await backend.createFolder(dir, "New Folder");
    } catch (e) {
      toastError("Couldn’t create folder", e);
      return;
    }
    await tree.refreshDir(dir);
    await tree.reveal(created);
    tree.startRename(created);
  };

  const onDelete = async (path: string, isDir: boolean) => {
    const ok = await backend.confirm(
      isDir ? "Delete folder" : "Delete file",
      `Move “${baseOf(path)}” to the Trash?${isDir ? " Everything inside it goes too." : ""}`,
    );
    if (!ok) return;
    // If the open document is (under) the target, detach the editor FIRST so a
    // later autosave can't rewrite the trashed path and resurrect the file.
    const ep = editor.path;
    if (ep && isUnder(ep, path)) editor.detach();
    else await editor.flush(); // persist unrelated edits before touching the tree
    try {
      await backend.trashPath(path);
    } catch (e) {
      toastError("Couldn’t delete", e);
      return;
    }
    await closeTabsUnder(path);
    await tree.refreshDir(parentOf(path));
    refreshGit();
    toast(`Moved “${baseOf(path)}” to the Trash`);
  };

  const tree = new FileTree(treeEl, backend, {
    // Focus the editor once the file is up: after "click a file, start
    // typing", keystrokes belong in the document — not in the tree, where
    // they'd be navigation (or worse).
    onOpenFile: (p) =>
      void openFile(p).then((ok) => {
        if (ok && activeTab()?.kind === "md") editor.focus();
      }),
    onRename: (p, n) => void onRename(p, n),
    onMove: (s, d) => void onMove(s, d),
    onNewFile: (d) => void onNewFileIn(d),
    onNewFolder: (d) => void onNewFolder(d),
    onDelete: (p, isDir) => void onDelete(p, isDir),
    onShowDiff: (p) => void showDiff(p),
    onDiscard: (p) => void discardChanges(p),
    onExpandedChange: () => saveSession(),
  });

  // -------------------------------------------------------------- diff view

  const diffView = $("diff-view");
  const diffTitle = $("diff-title");
  const diffStat = $("diff-stat");
  const diffBody = $("diff-body");
  let diffPath: string | null = null;

  const closeDiff = () => {
    diffView.classList.add("hidden");
    diffPath = null;
  };

  const showDiff = async (path: string) => {
    let text: string | null;
    try {
      text = await backend.gitDiff(path);
    } catch (e) {
      toastError("Couldn’t read the diff", e);
      return;
    }
    diffPath = path;
    diffTitle.textContent =
      rootPath && path.startsWith(rootPath + "/")
        ? path.slice(rootPath.length + 1)
        : baseOf(path);
    diffBody.innerHTML = "";
    if (!text) {
      diffStat.textContent = "";
      const empty = document.createElement("div");
      empty.className = "diff-empty";
      empty.textContent = "No uncommitted changes in this file.";
      diffBody.appendChild(empty);
    } else {
      const parsed = parseDiff(text);
      const frag = document.createDocumentFragment();
      for (const line of parsed.lines) {
        const el = document.createElement("div");
        el.className = `diff-line ${line.kind}`;
        el.textContent = line.text || " ";
        frag.appendChild(el);
      }
      diffBody.appendChild(frag);
      diffStat.textContent = diffStat_(parsed);
    }
    $("diff-discard").classList.toggle("hidden", !text);
    diffView.classList.remove("hidden");
    diffBody.scrollTop = 0;
  };

  /** Discard one file's changes, after saying plainly what that means. */
  const discardChanges = async (path: string) => {
    const status = gitMap.get(path);
    if (!status) {
      toast("Nothing to discard — this file matches the last commit.");
      return;
    }
    // Ask the backend what discard will *actually* do rather than guessing
    // from the status letter: a renamed file's letter reads as committed, but
    // its new path is not in HEAD, so discard would trash it — and a dialog
    // that promises a restore must never deliver a trashing.
    let committed: boolean;
    try {
      committed = (await backend.gitDiscardKind(path)) === "restore";
    } catch (e) {
      toastError("Couldn’t discard", e);
      return;
    }
    const ok = await backend.confirmChoice(
      "Discard changes",
      committed
        ? `Throw away your changes to “${baseOf(path)}” and go back to the last committed version?\n\nThis cannot be undone.`
        : `“${baseOf(path)}” has never been committed, so there is no version to go back to. It will be moved to the Trash instead.`,
      committed ? "Discard" : "Move to Trash",
      "Cancel",
    );
    if (!ok) return;
    // Cancel any pending autosave of this document before git touches the file.
    if (editor.path === path) await editor.flush().catch(() => {});
    let outcome: string;
    try {
      outcome = await backend.gitDiscard(path);
    } catch (e) {
      toastError("Couldn’t discard", e);
      return;
    }
    if (outcome === "trashed") {
      await closeTabsUnder(path);
      toast(`Moved “${baseOf(path)}” to the Trash`);
    } else {
      if (editor.path === path) await editor.reloadFromDisk().catch(() => {});
      toast(`Discarded changes to “${baseOf(path)}”`);
    }
    if (diffPath === path) closeDiff();
    await tree.refreshDir(parentOf(path));
    refreshGit();
  };

  $("diff-close").addEventListener("click", closeDiff);
  $("diff-discard").addEventListener("click", () => {
    if (diffPath) void discardChanges(diffPath);
  });

  // --------------------------------------------------------------- updates

  const runUpdateCheck = (silent: boolean) =>
    void checkForUpdates(
      { confirm: (t, m, ok, cancel) => backend.confirmChoice(t, m, ok, cancel) },
      { silent },
    );

  // --------------------------------------------------------------- git state

  let gitTimer: ReturnType<typeof setTimeout> | undefined;
  let gitSeq = 0;
  /** Signature of the last painted status, to skip no-op repaints. */
  let gitSig = "";
  let gitWarnedTruncated = false;
  /** Re-read `git status` and repaint the decorations. Debounced, and cheap
      enough to fire on every save and filesystem event. */
  const refreshGit = () => {
    clearTimeout(gitTimer);
    gitTimer = setTimeout(async () => {
      if (!rootPath) return;
      const seq = ++gitSeq;
      let info;
      try {
        info = await backend.gitStatus(rootPath);
      } catch {
        info = null; // git missing or the folder went away — just clear marks
      }
      if (seq !== gitSeq) return; // a newer refresh already landed
      // Repainting rebuilds the tree DOM, so skip it when nothing moved —
      // autosave and window focus both land here routinely.
      const sig = (info?.entries ?? []).map((e) => `${e.status}:${e.path}`).join("\n");
      if (sig === gitSig) return;
      gitSig = sig;
      gitMap = new Map((info?.entries ?? []).map((e) => [e.path, e.status]));
      tree.setGit(info);
      renderTabs();
      if (info?.truncated && !gitWarnedTruncated) {
        gitWarnedTruncated = true;
        toast("Too many git changes to mark them all — showing the first 5,000.");
      }
    }, 300);
  };

  // ------------------------------------------------------------- folder ops

  const setRoot = async (path: string, expanded: string[] = []) => {
    if (rootPath && rootPath !== path) {
      // Tabs from the previous folder would linger with no tree row, no git
      // badge, and a session entry that resurrects them forever — close them.
      await closeMany(
        tabs.filter((t) => !t.draft && !isUnder(t.path, path)).map((t) => t.path),
      );
    }
    rootPath = path;
    folderNameEl.textContent = baseOf(path);
    folderNameEl.title = path;
    sidebarEmpty.classList.add("hidden");
    if ($("search-panel").classList.contains("hidden")) {
      treeEl.classList.remove("hidden");
    }
    if (isTauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      void invoke("push_recent", { path }).catch(() => {
        /* scope-refused (corrupted recents) — the menu entry just won't stick */
      });
    }
    await tree.setRoot(path, expanded);
    void backend.watchFolder(path).catch(() => {
      /* watching is a nicety; the app works without it */
    });
    gitWarnedTruncated = false;
    gitSig = "";
    refreshGit();
    saveSession();
  };

  const openFolder = async () => {
    const picked = await backend.pickFolder();
    if (picked) await setRoot(picked);
  };

  /** Another window, with its own workspace. */
  const newWindow = async () => {
    if (!isTauri) {
      toast("Multiple windows need the desktop app.", { kind: "error" });
      return;
    }
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      await invoke("new_window");
    } catch (e) {
      toastError("Couldn’t open a new window", e);
    }
  };

  /** The workspace itself vanished — deleted, unmounted or renamed away. */
  const onRootGone = async () => {
    const name = rootPath ? baseOf(rootPath) : "The folder";
    // The files are gone with it: nothing to flush, nothing worth keeping —
    // except an unsaved draft, which lives only in memory.
    if (!editor.isDraft) editor.detach();
    tabs = tabs.filter((t) => t.draft);
    rootPath = null;
    tree.setGit(null);
    treeEl.classList.add("hidden");
    sidebarEmpty.classList.remove("hidden");
    if (tabs.length) await activate(DRAFT);
    else goWelcome();
    renderTabs();
    updateMenuState();
    saveSession();
    toast(`“${name}” is gone — it was moved, renamed or deleted.`, {
      kind: "error",
      duration: 8000,
    });
  };

  /** Open a recents entry — which may have been moved or deleted since. */
  const openRecent = async (path: string) => {
    try {
      await backend.listDir(path); // still accessible?
    } catch {
      toast(`Couldn’t open “${baseOf(path)}” — it may have been moved or deleted.`, {
        kind: "error",
      });
      return;
    }
    await setRoot(path);
  };

  /** New File makes an *unsaved draft* — no disk file until first Save. */
  const newDraft = async () => {
    const existing = tabs.find((t) => t.draft);
    if (existing) {
      await activate(DRAFT);
      return;
    }
    draftBuffer = "";
    tabs.push({ path: DRAFT, kind: "md", draft: true });
    await activate(DRAFT);
    editor.focus();
  };

  const newFolderHere = () => void onNewFolder(rootPath ?? "");

  /** Adopt `path` as a real file tab (after a draft's first save or Save As). */
  const adoptSavedPath = async (fromPath: string | null, path: string) => {
    tabs = tabs
      .map((t) =>
        (fromPath === null ? t.draft : t.path === fromPath)
          ? { path, kind: "md" as const }
          : t,
      )
      .filter((t, i, arr) => arr.findIndex((y) => y.path === t.path) === i);
    activePath = path;
    draftBuffer = "";
    if (rootPath && path.startsWith(rootPath + "/")) {
      await tree.refreshDir(parentOf(path));
      await tree.reveal(path);
    }
    renderTabs();
    updateMenuState();
    updateStatus();
    saveSession();
  };

  const save = async () => {
    const t = activeTab();
    if (!t || t.kind !== "md") return;
    if (t.draft) {
      const path = await backend.saveDialog("Untitled.md", rootPath);
      if (!path) return;
      try {
        await editor.saveToPath(path);
      } catch (e) {
        toastError("Couldn’t save", e);
        return;
      }
      await adoptSavedPath(null, path);
    } else {
      await editor.flush();
    }
  };

  const saveAs = async () => {
    const t = activeTab();
    if (!t || t.kind !== "md") return;
    const suggested = t.draft ? "Untitled.md" : baseOf(activePath!);
    const path = await backend.saveDialog(suggested, rootPath);
    if (!path) return;
    try {
      await editor.saveToPath(path);
    } catch (e) {
      toastError("Couldn’t save", e);
      return;
    }
    await adoptSavedPath(t.draft ? null : activePath, path);
  };

  const exportHtml = async () => {
    const t = activeTab();
    if (!t || t.kind !== "md") return;
    const stem = t.draft ? "Untitled" : baseOf(t.path).replace(MD_RE, "");
    const dest = await backend.exportDialog(`${stem}.html`, rootPath, "html");
    if (!dest) return;
    try {
      const html = await editor.toHtml(stem);
      await backend.writeFile(dest, html, null);
      toast(`Exported ${baseOf(dest)}`, {
        kind: "success",
        action: {
          label: "Reveal",
          run: () => void backend.revealPath(dest).catch(() => {}),
        },
      });
    } catch (e) {
      toastError("Couldn’t export", e);
    }
  };

  $("btn-open-folder").addEventListener("click", () => void openFolder());
  $("btn-open-folder-side").addEventListener("click", () => void openFolder());
  $("btn-open-folder-welcome").addEventListener("click", () => void openFolder());
  $("btn-new-welcome").addEventListener("click", () => void newDraft());
  $("btn-new-file").addEventListener("click", () => void newDraft());

  // ---------------------------------------------------------------- theme
  const THEME_KEY = "mad:theme";
  /** Tell the other windows a shared preference moved. */
  const broadcastPrefs = async () => {
    if (!isTauri) return;
    const { emit } = await import("@tauri-apps/api/event");
    void emit("prefs-changed", winLabel).catch(() => {});
  };
  const applyTheme = (light: boolean) => {
    document.documentElement.classList.toggle("light", light);
    localStorage.setItem(THEME_KEY, light ? "light" : "dark");
    editor.setMermaidTheme(light);
  };
  applyTheme(localStorage.getItem(THEME_KEY) === "light");
  const toggleTheme = () => {
    applyTheme(!document.documentElement.classList.contains("light"));
    // Theme is an app-wide preference, not a per-window one — a light window
    // beside a dark one is nobody's intention.
    void broadcastPrefs();
  };

  // ----------------------------------------------------------------- zoom
  const applyScale = () => {
    document.documentElement.style.setProperty("--doc-scale", String(docScale));
  };
  /** delta: +1 in, -1 out, 0 reset. */
  let zoomToast: ReturnType<typeof toast> | null = null;
  const zoom = (delta: number) => {
    docScale = delta === 0 ? 1 : clampScale(docScale + delta * 0.1);
    applyScale();
    saveSession();
    // Replace the previous zoom toast — holding ⌘= must not stack a column.
    zoomToast?.dismiss();
    zoomToast = toast(`Text size ${Math.round(docScale * 100)}%`, {
      duration: 1200,
    });
  };
  applyScale();

  // ------------------------------------------------------------ spellcheck
  const SPELL_KEY = "mad:spell";
  let spellOn = localStorage.getItem(SPELL_KEY) !== "off";
  const toggleSpellcheck = () => {
    spellOn = !spellOn;
    localStorage.setItem(SPELL_KEY, spellOn ? "on" : "off");
    editor.setSpellcheck(spellOn);
    toast(`Spell check ${spellOn ? "on" : "off"}`, { duration: 1400 });
  };
  editor.setSpellcheck(spellOn); // seed the editor's default (applied on mount)

  const isMd = () => {
    const t = activeTab();
    return !!t && t.kind === "md";
  };
  const isRich = () => isMd() && editor.mode === "rich" && !editor.isSplit;

  // ------------------------------------------------------------- searching
  const searchPanel = $("search-panel");
  const searchInput = $<HTMLInputElement>("search-input");
  const searchResults = $("search-results");
  const searchSummary = $("search-summary");
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  const SEARCH_OPTS_KEY = "mad:search-opts";
  const searchOpts: SearchOptions = {
    regex: false,
    caseSensitive: false,
    wholeWord: false,
    ...(() => {
      try {
        return JSON.parse(localStorage.getItem(SEARCH_OPTS_KEY) ?? "{}");
      } catch {
        return {};
      }
    })(),
  };
  const OPT_KEYS = { case: "caseSensitive", word: "wholeWord", regex: "regex" } as const;
  const reflectSearchOpts = () => {
    for (const btn of searchPanel.querySelectorAll<HTMLButtonElement>("[data-opt]")) {
      const key = OPT_KEYS[btn.dataset.opt as keyof typeof OPT_KEYS];
      btn.classList.toggle("on", searchOpts[key]);
      btn.setAttribute("aria-pressed", String(searchOpts[key]));
    }
  };
  for (const btn of searchPanel.querySelectorAll<HTMLButtonElement>("[data-opt]")) {
    btn.addEventListener("click", () => {
      const key = OPT_KEYS[btn.dataset.opt as keyof typeof OPT_KEYS];
      searchOpts[key] = !searchOpts[key];
      localStorage.setItem(SEARCH_OPTS_KEY, JSON.stringify(searchOpts));
      reflectSearchOpts();
      void runSearch();
    });
  }
  reflectSearchOpts();

  const openSearch = () => {
    if (!rootPath) {
      toast("Open a folder to search in.", { kind: "error" });
      return;
    }
    treeEl.classList.add("hidden");
    sidebarEmpty.classList.add("hidden");
    searchPanel.classList.remove("hidden");
    if (document.body.classList.contains("sidebar-hidden")) {
      document.body.classList.remove("sidebar-hidden");
      saveSession(); // the un-hide must survive a restart like any toggle
    }
    const sel = selectionText();
    if (sel && sel.length < 100) searchInput.value = sel;
    searchInput.focus();
    searchInput.select();
    if (searchInput.value) void runSearch();
  };
  const closeSearch = () => {
    searchPanel.classList.add("hidden");
    if (rootPath) treeEl.classList.remove("hidden");
    else sidebarEmpty.classList.remove("hidden");
  };
  $("btn-search").addEventListener("click", () =>
    searchPanel.classList.contains("hidden") ? openSearch() : closeSearch(),
  );
  $("search-close").addEventListener("click", closeSearch);

  const renderSearch = (hits: SearchHit[], query: string, truncated: boolean) => {
    searchResults.innerHTML = "";
    if (!query.trim()) {
      searchSummary.textContent = "";
      return;
    }
    if (hits.length === 0) {
      searchResults.innerHTML = `<div class="search-empty">No results</div>`;
      searchSummary.textContent = "";
      return;
    }
    const files = new Set(hits.map((h) => h.rel)).size;
    searchSummary.textContent =
      `${hits.length}${truncated ? "+" : ""} in ${files} file${files === 1 ? "" : "s"}`;
    let currentFile = "";
    for (const h of hits) {
      if (h.rel !== currentFile) {
        currentFile = h.rel;
        const head = document.createElement("div");
        head.className = "search-file";
        head.textContent = h.rel;
        head.title = h.rel;
        searchResults.appendChild(head);
      }
      const row = document.createElement("div");
      row.className = "search-hit";
      row.setAttribute("role", "option");
      row.tabIndex = -1;
      const chars = [...h.text];
      const before = escapeHtml(chars.slice(0, h.start).join(""));
      const match = escapeHtml(chars.slice(h.start, h.end).join(""));
      const after = escapeHtml(chars.slice(h.end).join(""));
      row.innerHTML = `<span class="ln">${h.line}</span><span class="tx">${before}<mark>${match}</mark>${after}</span>`;
      row.addEventListener("click", async () => {
        // Only reveal when the file actually opened — otherwise the line
        // would be selected in whatever document was already showing.
        if (await openFile(h.path)) editor.revealSourceLine(h.line);
      });
      searchResults.appendChild(row);
    }
  };

  let searchSeq = 0;
  const runSearch = async () => {
    if (!rootPath) return;
    const q = searchInput.value;
    if (q.trim().length < 2) {
      searchResults.innerHTML = q.trim()
        ? `<div class="search-empty">Keep typing…</div>`
        : "";
      searchSummary.textContent = "";
      return;
    }
    const seq = ++searchSeq;
    searchPanel.classList.add("busy");
    try {
      const res = await backend.searchFiles(rootPath, q, searchOpts);
      if (seq === searchSeq) renderSearch(res.hits, q, res.truncated); // drop stale
    } catch (e) {
      if (seq === searchSeq) {
        searchResults.innerHTML = `<div class="search-empty">${escapeHtml(
          searchOpts.regex ? "Invalid regular expression" : String(e),
        )}</div>`;
      }
    } finally {
      if (seq === searchSeq) searchPanel.classList.remove("busy");
    }
  };
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void runSearch(), 220);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeSearch();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      searchResults.querySelector<HTMLElement>(".search-hit")?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      searchResults.querySelector<HTMLElement>(".search-hit")?.click();
    }
  });
  searchResults.addEventListener("keydown", (e) => {
    const rows = [...searchResults.querySelectorAll<HTMLElement>(".search-hit")];
    const i = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      (rows[i + 1] ?? rows[0])?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (i <= 0) searchInput.focus();
      else rows[i - 1].focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      rows[i]?.click();
    } else if (e.key === "Escape") {
      closeSearch();
    }
  });

  // -------------------------------------------------------- command palette
  interface Command {
    title: string;
    hint?: string;
    run: () => void | Promise<void>;
    when?: () => boolean;
  }
  const commands: Command[] = [
    { title: "New File", hint: "⌘N", run: () => void newDraft() },
    { title: "New Window", hint: "⌘⇧N", run: () => void newWindow() },
    { title: "New Folder", run: () => newFolderHere(), when: () => !!rootPath },
    { title: "Open Folder…", hint: "⌘O", run: () => void openFolder() },
    { title: "Save", hint: "⌘S", run: () => void save(), when: isMd },
    { title: "Save As…", hint: "⌘⇧S", run: () => void saveAs(), when: isMd },
    { title: "Export as HTML…", run: () => void exportHtml(), when: isMd },
    {
      title: "Reveal in Finder",
      run: () => {
        const t = activeTab();
        if (t && !t.draft) void backend.revealPath(t.path).catch(() => {});
        else if (rootPath) void backend.revealPath(rootPath).catch(() => {});
      },
    },
    { title: "Close Tab", hint: "⌘W", run: () => activePath && void closeTab(activePath) },
    { title: "Close All Tabs", run: () => void closeMany(tabs.map((t) => t.path)) },
    {
      title: "Show Changes",
      hint: "⌘⇧D",
      run: () => activePath && void showDiff(activePath),
      when: () => !!activePath && !!gitMap.get(activePath),
    },
    {
      title: "Discard Changes…",
      run: () => activePath && void discardChanges(activePath),
      when: () => !!activePath && !!gitMap.get(activePath),
    },
    { title: "Search in Files…", hint: "⌘⇧F", run: openSearch },
    { title: "Find…", hint: "⌘F", run: () => openFind(false), when: isMd },
    { title: "Find & Replace…", hint: "⌘⌥F", run: () => openFind(true), when: isMd },
    {
      title: "Go to Heading…",
      hint: "⌘⇧O",
      run: () => void palette.show("#"),
      when: isMd,
    },
    {
      title: "Toggle Markdown Source",
      hint: "⌘⇧M",
      run: () => editor.toggleMode(),
      when: isMd,
    },
    { title: "Toggle Split Preview", hint: "⌘⇧V", run: () => toggleSplit(), when: isMd },
    { title: "Toggle Sidebar", hint: "⌘\\", run: () => toggleSidebar() },
    { title: "Check for Updates…", run: () => runUpdateCheck(false) },
    { title: "Toggle Light / Dark Theme", run: toggleTheme },
    { title: "Toggle Spell Check", run: toggleSpellcheck },
    { title: "Zoom In", hint: "⌘=", run: () => zoom(1) },
    { title: "Zoom Out", hint: "⌘-", run: () => zoom(-1) },
    { title: "Actual Size", hint: "⌘0", run: () => zoom(0) },
    // Formatting commands only work in the rich editor — offering them in
    // source or split view would be a silent no-op, so they hide instead.
    { title: "Bold", hint: "⌘B", run: () => editor.toggleBold(), when: isRich },
    { title: "Italic", hint: "⌘I", run: () => editor.toggleItalic(), when: isRich },
    { title: "Inline Code", hint: "⌘E", run: () => editor.toggleInlineCode(), when: isRich },
    { title: "Link", run: () => editor.toggleLink(), when: isRich },
    { title: "Quote", run: () => editor.toggleQuote(), when: isRich },
    { title: "Bullet List", run: () => editor.toggleBulletList(), when: isRich },
    { title: "Numbered List", run: () => editor.toggleOrderedList(), when: isRich },
    { title: "Heading 1", run: () => editor.setHeading(1), when: isRich },
    { title: "Heading 2", run: () => editor.setHeading(2), when: isRich },
    { title: "Heading 3", run: () => editor.setHeading(3), when: isRich },
  ];

  const palette = new CommandPalette({
    files: async () => {
      if (!rootPath) return [];
      const all = await backend.listAll(rootPath);
      return all.map((f) => ({
        title: baseOf(f.rel).replace(MD_RE, ""),
        // Show the containing folder, not the whole path — repeating the
        // filename on the right is noise. Still matches on the full path.
        subtitle: f.rel.includes("/") ? parentOf(f.rel) : undefined,
        search: f.rel,
        icon: fileIcon(f.rel),
        run: () => void openFile(f.path),
      }));
    },
    commands: () =>
      commands
        .filter((c) => (c.when ? c.when() : true))
        .map((c) => ({
          title: c.title,
          subtitle: c.hint,
          icon: ICON_COMMAND,
          run: c.run,
        })),
    outline: () =>
      editor.getOutline().map((h) => ({
        title: h.text || "(untitled heading)",
        subtitle: "H" + h.level,
        icon: ICON_HEADING,
        run: () => {
          showSurface("editor");
          editor.scrollToHeading(h.id);
        },
      })),
  });

  // ----------------------------------------------------------- find / replace
  const findBar = $("find-bar");
  const findInput = $<HTMLInputElement>("find-input");
  const replaceInput = $<HTMLInputElement>("replace-input");
  const findCount = $("find-count");
  const replaceRow = $("replace-row");
  const findOpts = { caseSensitive: false, wholeWord: false };

  const selectionText = () => {
    const s = window.getSelection()?.toString() ?? "";
    return s.includes("\n") ? "" : s.trim();
  };

  const reflectFindOpts = () => {
    for (const btn of findBar.querySelectorAll<HTMLButtonElement>("[data-find-opt]")) {
      const on =
        btn.dataset.findOpt === "case" ? findOpts.caseSensitive : findOpts.wholeWord;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", String(on));
    }
  };
  for (const btn of findBar.querySelectorAll<HTMLButtonElement>("[data-find-opt]")) {
    btn.addEventListener("click", () => {
      if (btn.dataset.findOpt === "case")
        findOpts.caseSensitive = !findOpts.caseSensitive;
      else findOpts.wholeWord = !findOpts.wholeWord;
      reflectFindOpts();
      doFind();
      findInput.focus();
    });
  }
  reflectFindOpts();

  const showCount = (r: { count: number; index: number }) => {
    findCount.textContent = r.count
      ? `${r.index || "–"} / ${r.count}`
      : findInput.value
        ? "No results"
        : "";
  };
  const doFind = () =>
    showCount(
      editor.find(findInput.value, { replace: replaceInput.value, ...findOpts }),
    );
  const openFind = (replace: boolean) => {
    if (!isMd()) return;
    const sel = selectionText();
    findBar.classList.remove("hidden");
    replaceRow.classList.toggle("hidden", !replace);
    if (sel) findInput.value = sel;
    findInput.focus();
    findInput.select();
    if (findInput.value) doFind();
  };
  const closeFind = () => {
    if (findBar.classList.contains("hidden")) return;
    findBar.classList.add("hidden");
    editor.clearFind();
    if (!editorEl.classList.contains("hidden")) editor.focus();
  };
  findInput.addEventListener("input", doFind);
  replaceInput.addEventListener("input", doFind);
  const findKeys = (e: KeyboardEvent, onEnter: () => void) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onEnter();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  };
  findInput.addEventListener("keydown", (e) =>
    findKeys(e, () => showCount(editor.findNext(!e.shiftKey))),
  );
  replaceInput.addEventListener("keydown", (e) =>
    findKeys(e, () => showCount(editor.replaceOne())),
  );
  $("find-next").addEventListener("click", () => showCount(editor.findNext(true)));
  $("find-prev").addEventListener("click", () => showCount(editor.findNext(false)));
  $("find-close").addEventListener("click", closeFind);
  $("replace-one").addEventListener("click", () => showCount(editor.replaceOne()));
  $("replace-all").addEventListener("click", () => {
    const n = editor.replaceAllMatches();
    findCount.textContent = n ? `${n} replaced` : "Nothing to replace";
  });

  // Rich ⇄ Markdown toggle.
  for (const btn of modeToggle.querySelectorAll("button")) {
    btn.addEventListener("click", () =>
      editor.setMode(btn.dataset.mode as EditorMode),
    );
  }

  // Split preview toggle.
  const btnSplit = $("btn-split");
  const reflectSplit = () => {
    btnSplit.classList.toggle("active", editor.isSplit);
    btnSplit.setAttribute("aria-pressed", String(editor.isSplit));
    modeToggle.classList.toggle("hidden", !isMd() || editor.isSplit);
  };
  const toggleSplit = () => {
    if (!isMd()) return;
    editor.toggleSplit();
    reflectSplit();
  };
  btnSplit.addEventListener("click", toggleSplit);

  // ------------------------------------------------------------ sidebar
  const sidebar = $("sidebar");
  const resizer = $("resizer");
  const toggleSidebar = () => {
    document.body.classList.toggle("sidebar-hidden");
    saveSession();
  };
  $("btn-sidebar").addEventListener("click", toggleSidebar);
  if (saved.sidebarWidth) sidebar.style.width = saved.sidebarWidth;
  if (saved.sidebarHidden) document.body.classList.add("sidebar-hidden");

  const startResize = (startX: number, startW: number) => {
    resizer.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(480, Math.max(180, startW + (ev.clientX - startX)));
      sidebar.style.width = `${w}px`;
    };
    const onUp = () => {
      resizer.classList.remove("dragging");
      document.body.style.cursor = "";
      saveSession();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    startResize(e.clientX, sidebar.getBoundingClientRect().width);
  });
  resizer.addEventListener("dblclick", () => {
    sidebar.style.width = "264px";
    saveSession();
  });
  resizer.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 32 : 8;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const w = sidebar.getBoundingClientRect().width + (e.key === "ArrowRight" ? step : -step);
    sidebar.style.width = `${Math.min(480, Math.max(180, w))}px`;
    saveSession();
  });

  // Links: a link to another note opens it here; the web opens out there.
  // Not inside the isTauri block — following a link between documents is the
  // app working, not a desktop integration, and it has to work in the browser
  // build too (which is also the only place it can be tested).
  const openExternal = async (url: string) => {
    if (!isTauri) {
      window.open(url, "_blank", "noopener");
      return;
    }
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  };
  document.addEventListener(
    "click",
    (e) => {
      const el = e.target instanceof Element ? e.target : null;
      const a = el?.closest("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      // The raw attribute, never a.href — see resolveLink.
      const target = resolveLink(a.getAttribute("href"), editor.path);
      if (target.kind === "ignore") return;
      e.preventDefault();
      if (target.kind === "external") {
        void openExternal(target.url).catch((err) =>
          toastError("Couldn’t open that link", err),
        );
      } else if (target.kind === "anchor") {
        editor.scrollToHeading(target.id);
      } else if (MD_RE.test(target.path) || IMG_RE.test(target.path)) {
        // Something mad can show: open it in a tab, like the tree would.
        void openFile(target.path);
      } else {
        // A PDF, a spreadsheet, a folder — hand it to the OS.
        void backend
          .openPath(target.path)
          .catch((err) => toastError(`Couldn’t open ${baseOf(target.path)}`, err));
      }
    },
    true,
  );

  // A drop the editor doesn't claim must never navigate the window away.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    // The editor's capture handler claims image drops (it stores the bytes
    // beside the note). Anything else dropped from Finder can't be opened in
    // place — a WKWebView drop carries file contents, not locations — so
    // answer the gesture instead of silently ignoring it.
    if (e.dataTransfer?.files.length) {
      toast("To edit a file here, open its folder (⌘O).", { kind: "error" });
    }
  });

  window.addEventListener("keydown", (e) => {
    // Escape closes the find bar, then the diff panel.
    if (e.key === "Escape" && !findBar.classList.contains("hidden")) {
      closeFind();
      return;
    }
    if (e.key === "Escape" && !diffView.classList.contains("hidden")) {
      closeDiff();
      return;
    }
    // The mapping lives in keys.ts (unit-tested); this switch only runs it.
    const action = resolveKey(
      {
        code: e.code, // physical key — robust across macOS ⌥ dead-keys
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
      },
      { native: isTauri, paletteOpen: palette.isOpen },
    );
    if (!action) return;
    e.preventDefault();
    switch (action.kind) {
      case "tab-digit": {
        const target =
          action.digit === 9 ? tabs[tabs.length - 1] : tabs[action.digit - 1];
        if (target) void activate(target.path);
        break;
      }
      case "tab-cycle": {
        if (!tabs.length) break;
        const i = tabs.findIndex((t) => t.path === activePath);
        void activate(tabs[(i + action.dir + tabs.length) % tabs.length].path);
        break;
      }
      case "quick-open":
        void palette.show("");
        break;
      case "palette":
        void palette.show(">");
        break;
      case "find":
        openFind(false);
        break;
      case "find-replace":
        openFind(true);
        break;
      case "search-files":
        openSearch();
        break;
      case "goto-heading":
        if (isMd()) void palette.show("#");
        break;
      case "close-tab":
        if (activePath) void closeTab(activePath);
        break;
      case "show-diff":
        if (activePath) void showDiff(activePath);
        break;
      case "toggle-sidebar":
        toggleSidebar();
        break;
      case "zoom":
        zoom(action.delta);
        break;
      case "save":
        void save();
        break;
      case "save-as":
        void saveAs();
        break;
      case "new-file":
        void newDraft();
        break;
      case "new-window":
        void newWindow();
        break;
      case "toggle-source":
        if (isMd()) editor.toggleMode();
        break;
      case "toggle-split":
        toggleSplit();
        break;
    }
  });
  window.addEventListener("blur", () => void editor.flush());
  // Coming back to the window is the moment to catch up on work done in a
  // terminal — and it covers the case where the repo root sits above the open
  // workspace, so `.git` isn't inside the watched tree.
  window.addEventListener("focus", () => refreshGit());

  if (isTauri) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const { listen } = await import("@tauri-apps/api/event");
    const { invoke } = await import("@tauri-apps/api/core");

    // Put this window's work safely on disk, asking about anything that would
    // be lost. Resolves false if the user decided to stay.
    //
    // No wall-clock cap: the flush may legitimately sit on a native dialog
    // (draft warning, save conflict) for as long as the user ponders it; the
    // Rust backstop only covers a webview that never answers at all.
    // Guards against a *concurrent* second settle only — two fast ⌘Qs must
    // not stack two dialogs. It is always released again, including on the
    // success path: this window may have agreed to a quit that another window
    // then cancelled, and a latch left set there made this window permanently
    // unclosable and blocked every future ⌘Q for the whole app.
    let settling = false;
    const settle = async (verb: string): Promise<boolean> => {
      if (settling) return false; // one dialog, one flush, however many asks
      settling = true;
      try {
        // localStorage is synchronous — the session survives a hung flush.
        clearTimeout(sessionTimer);
        persistSession(localStorage, buildSession(), SESSION);
        // Warn before losing an unsaved draft (drafts never autosave).
        if (hasUnsavedDraft()) {
          const proceed = await backend.confirm(
            "Unsaved file",
            `You have an unsaved file that will be lost. ${verb} without saving?`,
          );
          if (!proceed) return false;
        }
        await editor.flush();
        return true;
      } finally {
        settling = false;
      }
    };

    // ⌘Q: every window settles and answers; the app exits once the last one
    // agrees. A window that stands down simply never confirms, so the quit
    // quietly stops — the same "no" it has always meant.
    void listen("flush-and-exit", async () => {
      // ALWAYS ack first, even when re-entered: every ExitRequested arms a
      // fresh backstop, and each one must learn this webview is alive.
      void invoke("exit_ack").catch(() => {});
      if (await settle("Quit")) {
        void invoke("confirm_exit").catch(() => {});
      } else {
        // Declining cancels the quit for everyone — and clears the tally, so
        // no leftover agreement can quit the app at some later moment.
        void invoke("exit_declined").catch(() => {});
      }
    });

    // Closing a window is not quitting the app: settle this window's work,
    // then destroy only this window. (Tauri exits on its own once the last
    // one is gone.)
    const thisWindow = getCurrentWindow();
    void thisWindow.onCloseRequested(async (e) => {
      // Holding the close means WE are now responsible for completing it. If
      // anything below throws, the window becomes unclosable — so say so
      // rather than leaving the user clicking a dead button.
      e.preventDefault();
      try {
        if (!(await settle("Close"))) return;
        // Extra windows are ephemeral — leaving their session behind would
        // accumulate dead keys in localStorage forever.
        if (!isMainWindow) clearSession(localStorage, SESSION);
        await thisWindow.destroy();
      } catch (err) {
        toastError("Couldn’t close this window", err);
      }
    });

    // Native menu items.
    const menu: Record<string, () => void> = {
      // Note: New Window has no entry here — Rust creates the window itself,
      // so it works even when no window has focus to forward the event to.
      "menu-open-folder": () => void openFolder(),
      "menu-new-file": () => void newDraft(),
      "menu-new-folder": () => newFolderHere(),
      "menu-save": () => void save(),
      "menu-save-as": () => void saveAs(),
      "menu-export-html": () => void exportHtml(),
      "menu-close-tab": () => activePath && void closeTab(activePath),
      "menu-find": () => openFind(false),
      "menu-find-replace": () => openFind(true),
      "menu-search-files": () => openSearch(),
      "menu-toggle-spellcheck": () => toggleSpellcheck(),
      "menu-quick-open": () => void palette.show(""),
      "menu-command-palette": () => void palette.show(">"),
      "menu-toggle-source": () => {
        if (isMd()) editor.toggleMode();
      },
      "menu-goto-heading": () => isMd() && void palette.show("#"),
      "menu-toggle-split": () => toggleSplit(),
      "menu-toggle-sidebar": () => toggleSidebar(),
      "menu-toggle-theme": () => toggleTheme(),
      "menu-show-changes": () => activePath && void showDiff(activePath),
      "menu-check-updates": () => runUpdateCheck(false),
    };
    for (const [event, run] of Object.entries(menu)) void listen(event, run);
    void listen<number>("menu-zoom", (e) => zoom(e.payload));
    void listen<string>("menu-open-recent", (e) => void openRecent(e.payload));

    void listen("root-gone", () => void onRootGone());

    // The workspace changed underneath us (another app, a sync client, git…).
    void listen<{ dirs: string[]; paths: string[]; bulk: boolean; git: boolean }>(
      "fs-change",
      (e) => {
        if (e.payload.bulk) void tree.refreshAll();
        else if (e.payload.dirs.length) void tree.refreshDirs(e.payload.dirs);
        if (e.payload.paths.length) void editor.checkExternalChange();
        refreshGit();
      },
    );

    // A shared preference changed in another window — adopt it.
    void listen<string>("prefs-changed", (e) => {
      if (e.payload === winLabel) return; // our own broadcast
      applyTheme(localStorage.getItem(THEME_KEY) === "light");
    });

    // A quiet look for a newer release once the app has settled. Silent, so a
    // missing manifest or no network never interrupts anyone — and only from
    // the first window, or every window would race for the same download.
    if (isMainWindow) setTimeout(() => runUpdateCheck(true), 4000);

  }

  updateMenuState();

  // ------------------------------------------------------- restore session
  const lastRoot = isTauri ? saved.root : "/demo";
  if (lastRoot) {
    try {
      await backend.listDir(lastRoot); // still accessible?
      await setRoot(lastRoot, saved.expanded);
    } catch {
      rootPath = null;
    }
  }
  // Empty-state sidebar only once we know no folder is coming back —
  // unconditional, it flashed "No folder open" on every launch.
  if (!rootPath) sidebarEmpty.classList.remove("hidden");

  const root = rootPath;
  if (root) {
    const wanted = saved.tabs;
    if (wanted.length) {
      // Drop tabs whose file has since disappeared (one cheap index read).
      let known: Set<string>;
      try {
        const all = await backend.listAll(root);
        known = new Set(all.map((f) => f.path));
        // A maxed-out index is truncated, not exhaustive — never drop a
        // remembered tab on its say-so.
        if (all.length >= LIST_CAP) for (const p of wanted) known.add(p);
      } catch {
        known = new Set(wanted);
      }
      // Merge, never replace: the user may have opened something during the
      // async startup (the Welcome buttons are live), and restoring the
      // previous session must not destroy what they just started.
      const restored = usableTabs(wanted, root, known)
        .filter((p) => !tabs.some((t) => t.path === p))
        .map((p) => ({
          path: p,
          kind: IMG_RE.test(p) ? ("img" as const) : ("md" as const),
        }));
      tabs = [...restored, ...tabs];
      renderTabs();
      if (activePath === null) {
        const target =
          saved.active && tabs.some((t) => t.path === saved.active)
            ? saved.active
            : (tabs[0]?.path ?? null);
        if (target) await activate(target);
      }
    } else if (!isTauri) {
      await openFile("/demo/welcome.md");
    }
  }
  updateStatus();
}

void init().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<div style="padding:40px;font:14px system-ui;color:#c33">mad failed to start: ${String(e)}</div>`;
});
