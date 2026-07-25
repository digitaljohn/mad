import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { callCommand, outline, replaceAll, $prose } from "@milkdown/kit/utils";
import { DOMSerializer } from "@milkdown/kit/prose/model";
import {
  bulletListSchema,
  remarkPreserveEmptyLinePlugin,
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  wrapInHeadingCommand,
} from "@milkdown/kit/preset/commonmark";
import {
  search,
  SearchQuery,
  setSearchState,
  findNext,
  findPrev,
  replaceNext,
  replaceAll as pmReplaceAll,
  getSearchState,
} from "prosemirror-search";
import { imageBlockSchema } from "@milkdown/kit/component/image-block";
import { isConflict, type Backend } from "./backend";
import { toast, toastError } from "./toast";

/**
 * Milkdown's image block stores its display zoom in the markdown `alt` slot,
 * so round-tripping `![diagram](x.png)` rewrites it as `![1.00](x.png)` and
 * destroys the alt text. Keep alt text as alt text; fall back to the zoom
 * encoding only for images that have none, so resizing still round-trips.
 */
const imageAltFix = imageBlockSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...base.attrs, alt: { default: "", validate: "string" } },
    parseDOM: [
      {
        tag: `img[data-type="image-block"]`,
        getAttrs: (dom: HTMLElement | string) => {
          const el = dom as HTMLElement;
          return {
            src: el.getAttribute("src") || "",
            alt: el.getAttribute("alt") || "",
            caption: el.getAttribute("caption") || "",
            ratio: Number(el.getAttribute("ratio") ?? 1) || 1,
          };
        },
      },
    ],
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        const raw = String((node as { alt?: string }).alt ?? "");
        const zoom = raw !== "" && !Number.isNaN(Number(raw));
        state.addNode(type, {
          src: node.url as string,
          caption: (node.title as string) ?? "",
          alt: zoom ? "" : raw,
          ratio: zoom && Number(raw) !== 0 ? Number(raw) : 1,
        });
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        const ratio = Number(node.attrs.ratio);
        state.openNode("paragraph");
        state.addNode("image", undefined, undefined, {
          title: node.attrs.caption,
          url: node.attrs.src,
          alt:
            node.attrs.alt ||
            (Number.isFinite(ratio) && ratio !== 1 ? ratio.toFixed(2) : ""),
        });
        state.closeNode();
      },
    },
  };
});

export interface OutlineItem {
  text: string;
  level: number;
  id: string;
}

export interface FindOptions {
  replace?: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

export interface DocStats {
  words: number;
  chars: number;
  lines: number;
  /** Whole minutes at ~220 wpm, minimum 1 for a non-empty document. */
  readingMinutes: number;
  /** 1-based caret position — only meaningful in source mode. */
  cursor: { line: number; col: number } | null;
}

import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame-dark.css";
import "prosemirror-search/style/search.css";

export type SaveState = "saved" | "edited" | "saving" | "unsaved";
export type EditorMode = "rich" | "source";

/**
 * Milkdown keeps `bullet_list.spread` as the string "true"/"false" but hands it
 * to mdast unchanged, and "false" is truthy — so every bullet list serializes
 * loose, gaining a blank line between items on each save. Coerce it properly.
 * (The ordered-list schema already does this; only bullet lists are affected.)
 */
const tightBulletLists = bulletListSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        state
          .openNode("list", undefined, {
            ordered: false,
            spread: node.attrs.spread === true || node.attrs.spread === "true",
          })
          .next(node.content)
          .closeNode();
      },
    },
  };
});

/** Largest image we'll base64 through the IPC bridge. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** Collapse `.` / `..` segments of an absolute POSIX path. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}

/** Relative path from `fromDir` to `target` (both absolute POSIX paths). */
function relativize(fromDir: string, target: string): string {
  const from = fromDir.split("/").filter(Boolean);
  const to = target.split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  return [...Array(from.length - i).fill(".."), ...to.slice(i)].join("/");
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exactly one trailing newline, the way every other text editor writes files.
    ProseMirror keeps a trailing empty paragraph that would otherwise add a
    blank line on the first save of every document. */
function normalizeTrailer(md: string): string {
  return md.trim() ? md.replace(/\n+$/, "") + "\n" : "";
}

/** dataTransfer type used for drags out of the sidebar tree. */
export const TREE_IMAGE_DND = "application/x-mad-image";

export class MarkdownEditor {
  private crepe: Crepe | null = null;
  private host: HTMLElement;
  private richEl: HTMLElement;
  private sourceEl: HTMLTextAreaElement;
  private _mode: EditorMode = "rich";
  private split = false;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private modeBeforeSplit: EditorMode = "rich";
  private currentPath: string | null = null;
  /** Content (of the active surface) as of the last successful save/open. */
  private lastSaved = "";
  /** On-disk change stamp for currentPath, used to detect external edits. */
  private stamp = "";
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** All open/save operations run through this chain — never concurrently. */
  private chain: Promise<unknown> = Promise.resolve();
  private syncingScroll = false;

  constructor(
    host: HTMLElement,
    private backend: Backend,
    private onState: (state: SaveState) => void,
    private onMode?: (mode: EditorMode) => void,
    /** Fired after an image is saved beside the doc (paste/drop/upload). */
    private onAssetSaved?: (dir: string) => void,
    /** Fired whenever the document content or caret may have changed. */
    private onChanged?: () => void,
  ) {
    this.richEl = document.createElement("div");
    this.richEl.className = "editor-rich";
    this.sourceEl = document.createElement("textarea");
    this.sourceEl.className = "editor-source hidden";
    this.sourceEl.spellcheck = false;
    this.sourceEl.setAttribute("autocomplete", "off");
    this.sourceEl.setAttribute("autocapitalize", "off");
    this.sourceEl.setAttribute("aria-label", "Markdown source");
    this.host = host;
    host.append(this.richEl, this.sourceEl);

    this.sourceEl.addEventListener("input", () => {
      if (this._mode === "source") this.scheduleSave();
      if (this.split) this.schedulePreview();
      this.onChanged?.();
    });
    for (const ev of ["keyup", "click", "select"] as const) {
      this.sourceEl.addEventListener(ev, () => this.onChanged?.());
    }
    // Split view: keep the rendered pane roughly aligned with the source.
    this.sourceEl.addEventListener("scroll", () => this.syncScroll());

    // Accept image drags from the sidebar tree; capture phase so
    // ProseMirror's own drop handling never sees them.
    host.addEventListener(
      "dragover",
      (e) => {
        const types = e.dataTransfer?.types;
        if (types?.includes(TREE_IMAGE_DND) || types?.includes("Files")) {
          e.preventDefault();
          e.dataTransfer!.dropEffect = "copy";
        }
      },
      true,
    );
    host.addEventListener(
      "drop",
      (e) => {
        const treePath = e.dataTransfer?.getData(TREE_IMAGE_DND);
        if (treePath) {
          e.preventDefault();
          e.stopPropagation();
          this.clearDropCursor();
          this.insertImageAt(treePath, e.clientX, e.clientY);
          return;
        }
        // Files dragged in from Finder: save them beside the note, insert.
        const images = [...(e.dataTransfer?.files ?? [])].filter((f) =>
          f.type.startsWith("image/"),
        );
        if (images.length) {
          e.preventDefault();
          e.stopPropagation();
          this.clearDropCursor();
          void this.insertDroppedFiles(images, e.clientX, e.clientY);
        }
      },
      true,
    );

    // Paste an image straight from the clipboard (e.g. a screenshot).
    // Capture phase so we claim it BEFORE ProseMirror / the contenteditable
    // default — otherwise the image gets inserted twice.
    host.addEventListener(
      "paste",
      (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const imgs: File[] = [];
        for (const it of items) {
          if (it.kind === "file" && it.type.startsWith("image/")) {
            const f = it.getAsFile();
            if (f) imgs.push(f);
          }
        }
        if (!imgs.length) return;
        if (!this.currentPath) {
          // Images live beside the note, so there has to be a note first.
          e.preventDefault();
          e.stopPropagation();
          toast("Save this file first — images are stored next to it.", {
            kind: "error",
          });
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        void this.pasteImages(imgs);
      },
      true,
    );
  }

  /** We swallow drops before ProseMirror sees them, so its dropcursor never
      hears the event that would clear the indicator line — nudge it. */
  private clearDropCursor() {
    this.crepe?.editor.action((ctx) => {
      ctx
        .get(editorViewCtx)
        .dom.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
    });
  }

  get path() {
    return this.currentPath;
  }

  get mode() {
    return this._mode;
  }

  get isMounted() {
    return this.crepe !== null;
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const p = this.chain.then(op);
    this.chain = p.catch(() => {});
    return p;
  }

  /** Resolves false if pending edits could not be saved (file not switched). */
  openFile(path: string): Promise<boolean> {
    return this.enqueue(() => this.doOpen(path));
  }

  /** Open a brand-new unsaved draft — no path on disk, never autosaved. */
  openDraft(content = ""): Promise<boolean> {
    return this.enqueue(() => this.doOpenDraft(content));
  }

  /** Write the current content to `path` and adopt it as the file being
      edited (first save of a draft, or Save As). */
  saveToPath(path: string): Promise<void> {
    return this.enqueue(() => this.doSaveTo(path));
  }

  /** Adopt a new path without writing (after an on-disk rename/move). */
  adoptPath(newPath: string) {
    this.currentPath = newPath;
  }

  /** Cancel any pending save and forget the current path so no later save can
      rewrite it — used when the open file is deleted out from under us. */
  detach() {
    clearTimeout(this.saveTimer);
    this.currentPath = null;
    this.stamp = "";
    this.dirty = false;
  }

  /** True when the active document has never been saved to disk. */
  get isDraft() {
    return this.currentPath === null;
  }

  /** Snapshot of the active content (for orchestrating saves from outside). */
  getContent(): string {
    return this.content();
  }

  /** True when the buffer differs from what's on disk. */
  get hasUnsavedChanges() {
    return this.content() !== this.lastSaved;
  }

  // -------------------------------------------------- external file changes

  /** Re-read the open file if it changed on disk. Runs on the save chain, so
      it can never interleave with an in-flight write. */
  checkExternalChange(): Promise<void> {
    return this.enqueue(() => this.doCheckExternal());
  }

  /** Throw the buffer away and re-read from disk. Unlike checkExternalChange
      this does not care whether there were unsaved edits — the caller has
      already decided (discarding changes, say), so a pending autosave must be
      cancelled before it can write the stale content back. */
  reloadFromDisk(): Promise<void> {
    clearTimeout(this.saveTimer);
    return this.enqueue(async () => {
      const path = this.currentPath;
      if (!path || !this.crepe) return;
      clearTimeout(this.saveTimer);
      const data = await this.backend.readFile(path);
      this.applyContent(data.content);
      this.stamp = data.stamp;
      this.lastSaved = this.content();
      this.dirty = false;
      this.onState("saved");
      this.onChanged?.();
    });
  }

  private async doCheckExternal(): Promise<void> {
    const path = this.currentPath;
    if (!path || !this.crepe) return;
    // Cheap stat first: watch events fire for our own saves too, and re-reading
    // the whole file on every autosave would be pure waste.
    try {
      if ((await this.backend.fileStamp(path)) === this.stamp) return;
    } catch {
      return;
    }
    let data;
    try {
      data = await this.backend.readFile(path);
    } catch {
      return; // gone or unreadable — the tree refresh will deal with it
    }
    if (data.stamp === this.stamp) return;
    if (this.content() !== this.lastSaved) {
      // Don't throw away the user's edits; the save will offer a choice.
      toast("This file also changed on disk — saving will ask what to keep.", {
        kind: "error",
        duration: 7000,
      });
      return;
    }
    this.applyContent(data.content);
    this.stamp = data.stamp;
    this.lastSaved = this.content();
    this.dirty = false;
    this.onState("saved");
    this.onChanged?.();
    toast("Reloaded — the file changed on disk");
  }

  /** Push `markdown` into whichever surfaces are live. */
  private applyContent(markdown: string) {
    if (this._mode === "rich" || this.split) {
      this.crepe?.editor.action(replaceAll(markdown, true));
    }
    if (this._mode === "source") this.sourceEl.value = markdown;
  }

  // ------------------------------------------------------ outline & commands

  /** Headings of the current document, for the palette's `#` mode. */
  getOutline(): OutlineItem[] {
    if (!this.crepe) return [];
    try {
      return this.crepe.editor.action(outline());
    } catch {
      return [];
    }
  }

  /** Scroll a heading (by its generated id) into view and focus it. */
  scrollToHeading(id: string) {
    const el = this.richEl.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** Word / character / line counts for the status bar. */
  getStats(): DocStats {
    const text = this.content();
    const words = text.trim() ? (text.trim().match(/[\p{L}\p{N}'’-]+/gu)?.length ?? 0) : 0;
    const lines = text ? text.split("\n").length : 0;
    let cursor: DocStats["cursor"] = null;
    if (this._mode === "source" && document.activeElement === this.sourceEl) {
      const upto = this.sourceEl.value.slice(0, this.sourceEl.selectionStart ?? 0);
      const nl = upto.lastIndexOf("\n");
      cursor = { line: upto.split("\n").length, col: upto.length - nl };
    }
    return {
      words,
      chars: text.length,
      lines,
      readingMinutes: words ? Math.max(1, Math.round(words / 220)) : 0,
      cursor,
    };
  }

  private run(slice: Parameters<typeof callCommand>[0], payload?: unknown) {
    if (this._mode !== "rich" || !this.crepe) return;
    this.crepe.editor.action(callCommand(slice, payload));
    this.crepe.editor.action((ctx) => ctx.get(editorViewCtx).focus());
  }

  toggleBold() {
    this.run(toggleStrongCommand.key);
  }
  toggleItalic() {
    this.run(toggleEmphasisCommand.key);
  }
  toggleInlineCode() {
    this.run(toggleInlineCodeCommand.key);
  }
  /** Link the selection (empty href → Crepe's link tooltip lets you fill it). */
  toggleLink(href = "") {
    this.run(toggleLinkCommand.key, { href });
  }
  toggleQuote() {
    this.run(wrapInBlockquoteCommand.key);
  }
  toggleBulletList() {
    this.run(wrapInBulletListCommand.key);
  }
  toggleOrderedList() {
    this.run(wrapInOrderedListCommand.key);
  }
  setHeading(level: number) {
    this.run(wrapInHeadingCommand.key, level);
  }

  focus() {
    if (this._mode === "source" || this.split) this.sourceEl.focus();
    else this.crepe?.editor.action((ctx) => ctx.get(editorViewCtx).focus());
  }

  /** Insert an image at the caret (used by paste + palette). */
  private insertImageAtCursor(rel: string) {
    if (!this.crepe) return;
    this.crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const type = view.state.schema.nodes["image-block"];
      if (!type) return;
      const node = type.createAndFill({ src: rel });
      if (!node) return;
      const tr = view.state.tr.replaceSelectionWith(node).scrollIntoView();
      view.dispatch(tr);
      view.focus();
    });
  }

  private async pasteImages(files: File[]) {
    for (const file of files) {
      try {
        const rel = await this.upload(file);
        if (this._mode === "source") {
          this.spliceSource(`![](${encodeURI(rel)})\n`);
        } else {
          this.insertImageAtCursor(rel);
        }
      } catch (e) {
        toastError("Couldn’t paste image", e);
      }
    }
  }

  /** Insert text at the source textarea's caret. */
  private spliceSource(snippet: string) {
    const ta = this.sourceEl;
    const at = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, at) + snippet + ta.value.slice(at);
    ta.selectionStart = ta.selectionEnd = at + snippet.length;
    this.scheduleSave();
    if (this.split) this.schedulePreview();
    this.onChanged?.();
  }

  private spellcheckOn = true;

  /** Toggle native spell-check underlines on both editing surfaces. */
  setSpellcheck(on: boolean) {
    this.spellcheckOn = on;
    this.sourceEl.spellcheck = on;
    const pm = this.richEl.querySelector<HTMLElement>(".ProseMirror");
    if (pm) pm.spellcheck = on;
  }

  /** Switch to source view and select/scroll to a 1-based line (search jump). */
  revealSourceLine(line: number) {
    if (this._mode !== "source" && !this.split) this.setMode("source");
    const ta = this.sourceEl;
    const lines = ta.value.split("\n");
    let start = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) start += lines[i].length + 1;
    const end = start + (lines[line - 1]?.length ?? 0);
    ta.focus();
    ta.setSelectionRange(start, end);
    // Approximate scroll: proportional to caret position in the text.
    const ratio = start / Math.max(1, ta.value.length);
    ta.scrollTop = Math.max(0, ratio * ta.scrollHeight - ta.clientHeight / 2);
    this.onChanged?.();
  }

  /** Save now if the document differs from what's on disk. */
  flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    return this.enqueue(() => this.doSave());
  }

  /** The current document content, from whichever surface is active. */
  private content(): string {
    if (this._mode === "source") return this.sourceEl.value;
    return this.richMarkdown();
  }

  /** Serialized rich document, normalized to exactly one trailing newline —
      ProseMirror keeps a trailing empty paragraph that would otherwise add a
      blank line to the file on every first save. */
  private richMarkdown(): string {
    return normalizeTrailer(this.crepe ? this.crepe.getMarkdown() : "");
  }

  toggleMode() {
    void this.setMode(this._mode === "rich" ? "source" : "rich");
  }

  get isSplit() {
    return this.split;
  }

  toggleSplit() {
    this.setSplit(!this.split);
  }

  /** Split view: raw markdown on the left, live rendered preview on the right,
      reusing the existing source + rich surfaces (no second editor). */
  setSplit(on: boolean) {
    if (on === this.split) return;
    this.split = on;
    this.host.classList.toggle("split", on);
    if (on) {
      this.modeBeforeSplit = this._mode;
      if (this._mode === "rich") {
        this.sourceEl.value = this.richMarkdown();
        this._mode = "source";
        this.onMode?.("source");
      }
      this.richEl.classList.remove("hidden");
      this.sourceEl.classList.remove("hidden");
      this.crepe?.setReadonly(true); // right pane is a preview
      this.updatePreview();
      this.sourceEl.focus();
    } else {
      this.crepe?.setReadonly(false);
      if (this.modeBeforeSplit === "rich") {
        this.setMode("rich"); // source → rich (also fixes visibility)
      } else {
        this.richEl.classList.add("hidden");
        this.sourceEl.classList.remove("hidden");
      }
    }
  }

  /** Mirror the source pane's scroll position onto the rendered preview. */
  private syncScroll() {
    if (!this.split || this.syncingScroll) return;
    this.syncingScroll = true;
    requestAnimationFrame(() => {
      const src = this.sourceEl;
      const dst = this.richEl;
      const srcMax = src.scrollHeight - src.clientHeight;
      const dstMax = dst.scrollHeight - dst.clientHeight;
      if (srcMax > 0 && dstMax > 0) {
        dst.scrollTop = (src.scrollTop / srcMax) * dstMax;
      }
      this.syncingScroll = false;
    });
  }

  private schedulePreview() {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.updatePreview(), 250);
  }

  private updatePreview() {
    if (!this.split || !this.crepe) return;
    this.crepe.editor.action(replaceAll(this.sourceEl.value, true));
  }

  setMode(mode: EditorMode) {
    if (mode === this._mode || this.split) return;
    if (mode === "source") {
      // rich → source: surface the serialized markdown for raw editing.
      this.sourceEl.value = this.richMarkdown();
      this._mode = "source";
      this.richEl.classList.add("hidden");
      this.sourceEl.classList.remove("hidden");
      this.sourceEl.focus();
    } else {
      // source → rich: parse the raw text back into the WYSIWYG document.
      const text = this.sourceEl.value;
      this._mode = "rich";
      this.crepe?.editor.action(replaceAll(text, true));
      this.sourceEl.classList.add("hidden");
      this.richEl.classList.remove("hidden");
      // Edits made as raw text must still persist.
      if (text !== this.lastSaved) this.scheduleSave();
    }
    this.onMode?.(this._mode);
    this.onChanged?.();
  }

  private async doOpen(path: string): Promise<boolean> {
    await this.doSave(); // persist pending edits of the previous file
    // Only block when a *real file's* save failed — a draft (no path) is
    // preserved by the caller, so its always-dirty state must not block.
    if (this.currentPath && this.dirty) return false;
    const { content: markdown, stamp } = await this.backend.readFile(path);
    this.currentPath = path;
    this.stamp = stamp;
    if (!this.crepe) {
      await this.mount(this._mode === "rich" || this.split ? markdown : "");
    } else if (this._mode === "rich" || this.split) {
      // flush=true resets undo history — switching files shouldn't be undoable.
      this.crepe.editor.action(replaceAll(markdown, true));
    }
    if (this._mode === "source") this.sourceEl.value = markdown;
    if (this.split) this.updatePreview();
    // Baseline the *serialized* doc, not the raw file text: Crepe may
    // normalize markdown (list bullets, spacing), and normalization alone
    // must never count as an edit or rewrite an untouched file.
    this.lastSaved = this.content();
    this.dirty = false;
    this.onState("saved");
    this.onChanged?.();
    return true;
  }

  private async doOpenDraft(content: string): Promise<boolean> {
    await this.doSave(); // persist pending edits of the previous file
    if (this.currentPath && this.dirty) return false;
    this.currentPath = null;
    this.stamp = "";
    if (!this.crepe) {
      await this.mount(this._mode === "rich" || this.split ? content : "");
    } else if (this._mode === "rich" || this.split) {
      this.crepe.editor.action(replaceAll(content, true));
    }
    if (this._mode === "source") this.sourceEl.value = content;
    this.lastSaved = this.content();
    this.dirty = false;
    this.onState("unsaved");
    this.onChanged?.();
    return true;
  }

  private async doSaveTo(path: string): Promise<void> {
    const content = this.content();
    this.onState("saving");
    try {
      // No stamp check: the user picked this destination explicitly and the
      // native dialog already handled the overwrite prompt.
      this.stamp = await this.backend.writeFile(path, content, null);
      this.currentPath = path;
      this.lastSaved = content;
      this.dirty = false;
      this.onState("saved");
      this.onChanged?.();
    } catch (e) {
      this.dirty = true;
      this.onState(this.currentPath ? "edited" : "unsaved");
      throw e; // let the caller report the failure
    }
  }

  private async doSave(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (!this.currentPath || !this.crepe) return;
    const path = this.currentPath;
    // Compare actual content — the dirty flag lags markdownUpdated's
    // internal debounce and misses keystrokes younger than ~200ms.
    const markdown = this.content();
    if (markdown === this.lastSaved) {
      // Nothing to write — but the UI may still be showing "Edited" from a
      // change that normalized away, so settle it.
      this.dirty = false;
      this.onState("saved");
      return;
    }
    this.onState("saving");
    try {
      this.stamp = await this.backend.writeFile(path, markdown, this.stamp || null);
      this.settleAfterWrite(markdown);
    } catch (e) {
      if (isConflict(e)) {
        await this.resolveConflict(path, markdown);
        return;
      }
      toastError("Couldn’t save", e);
      this.dirty = true;
      this.onState("edited");
    }
  }

  private settleAfterWrite(written: string) {
    this.lastSaved = written;
    // Edits typed while the write was in flight stay pending.
    if (this.content() === written) {
      this.dirty = false;
      this.onState("saved");
    } else {
      this.dirty = true;
      this.onState("edited");
    }
    this.onChanged?.();
  }

  /** The file changed underneath us: let the user pick which version wins. */
  private async resolveConflict(path: string, markdown: string) {
    this.onState("edited");
    const overwrite = await this.backend.confirmChoice(
      "File changed on disk",
      `“${path.split("/").pop()}” was modified by another app since you opened it.\n\nKeep your version, or discard it and load what's on disk?`,
      "Keep Mine",
      "Reload From Disk",
    );
    if (overwrite) {
      try {
        this.stamp = await this.backend.writeFile(path, markdown, null);
        this.settleAfterWrite(markdown);
        return;
      } catch (e) {
        toastError("Couldn’t save", e);
        this.dirty = true;
        this.onState("edited");
        return;
      }
    }
    try {
      const data = await this.backend.readFile(path);
      this.applyContent(data.content);
      this.stamp = data.stamp;
      this.lastSaved = this.content();
      this.dirty = false;
      this.onState("saved");
      this.onChanged?.();
    } catch (e) {
      toastError("Couldn’t reload", e);
    }
  }

  private scheduleSave() {
    this.dirty = true;
    // A draft (no path) is never autosaved — it stays "unsaved" until the
    // user picks a location via Save.
    if (!this.currentPath) {
      this.onState("unsaved");
      return;
    }
    this.onState("edited");
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 800);
  }

  /** Map a markdown image URL to something the webview can display. */
  private resolveUrl = (url: string): string | Promise<string> => {
    if (/^(https?:|data:|asset:|blob:|file:)/i.test(url) || !url) return url;
    // Markdown destinations are often percent-encoded (`my%20image.png`);
    // decode before hitting the filesystem. Raw '%' in a filename would
    // throw — keep the original in that case.
    let raw = url;
    try {
      raw = decodeURIComponent(url);
    } catch {
      /* keep as-is */
    }
    const abs = raw.startsWith("/")
      ? raw
      : this.currentPath
        ? normalize(dirOf(this.currentPath) + "/" + raw)
        : raw;
    return this.backend.toDisplayUrl(abs).catch(() => url);
  };

  /** Insert an image block for `absPath` at the drop coordinates. */
  private insertImageAt(absPath: string, x: number, y: number) {
    if (!this.currentPath) {
      toast("Save this file first — image links are relative to it.", {
        kind: "error",
      });
      return;
    }
    this.insertRelImageAt(relativize(dirOf(this.currentPath), absPath), x, y);
  }

  /** Upload Finder-dropped images beside the note, then insert blocks. */
  private async insertDroppedFiles(files: File[], x: number, y: number) {
    for (const file of files) {
      try {
        const rel = await this.upload(file);
        this.insertRelImageAt(rel, x, y);
      } catch (e) {
        toastError("Couldn’t add image", e);
      }
    }
  }

  /** Insert an image with an already-relative src at drop coordinates. */
  private insertRelImageAt(rel: string, x: number, y: number) {
    if (this._mode === "source") {
      this.spliceSource(`![](${encodeURI(rel)})\n`);
      this.sourceEl.focus();
      return;
    }
    if (!this.crepe) return;
    this.crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const type = view.state.schema.nodes["image-block"];
      if (!type) return;
      const node = type.createAndFill({ src: rel });
      if (!node) return;
      const posInfo = view.posAtCoords({ left: x, top: y });
      let insertAt = view.state.doc.content.size; // fallback: end of doc
      if (posInfo) {
        const $pos = view.state.doc.resolve(posInfo.pos);
        // Land after the top-level block under the cursor.
        insertAt = $pos.depth === 0 ? posInfo.pos : $pos.after(1);
      }
      view.dispatch(view.state.tr.insert(insertAt, node).scrollIntoView());
      view.focus();
    });
  }

  /** Store the image beside the markdown file, reference it relatively. */
  private upload = async (file: File): Promise<string> => {
    if (!this.currentPath) throw new Error("no file open");
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `image is ${Math.round(file.size / 1e6)} MB — the limit is ${MAX_UPLOAD_BYTES / 1e6} MB`,
      );
    }
    const dir = dirOf(this.currentPath);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const name = await this.backend.saveImage(
      dir,
      file.name || "image.png",
      btoa(binary),
    );
    this.onAssetSaved?.(dir); // let the app refresh the file tree
    return name;
  };

  private async mount(markdown: string) {
    const crepe = new Crepe({
      root: this.richEl,
      defaultValue: markdown,
      features: {
        [Crepe.Feature.Latex]: false,
      },
      featureConfigs: {
        [Crepe.Feature.ImageBlock]: {
          onUpload: this.upload,
          proxyDomURL: this.resolveUrl,
        },
        [Crepe.Feature.Placeholder]: {
          text: "Write, or press / for blocks…",
        },
        [Crepe.Feature.CodeMirror]: {
          // Render a live diagram under ```mermaid code blocks.
          renderPreview: (
            language: string,
            content: string,
            applyPreview: (v: string | HTMLElement | null) => void,
          ) => this.renderMermaid(language, content, applyPreview),
        },
      },
    });

    crepe.on((api) => {
      api.markdownUpdated((_ctx, markdown, prevMarkdown) => {
        if (this._mode !== "rich") return;
        // Compare the same normalized form we save, or merely *opening* a file
        // would look like an edit.
        if (markdown === prevMarkdown || normalizeTrailer(markdown) === this.lastSaved)
          return;
        this.scheduleSave();
        this.onChanged?.();
      });
    });

    // Serialize the way people actually write markdown, so simply opening and
    // saving a note doesn't rewrite its bullets and rules.
    crepe.editor.config((ctx) => {
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({
        ...prev,
        bullet: "-" as const,
        rule: "-" as const,
      }));
    });

    // In-editor find/replace via prosemirror-search (registered before create).
    crepe.editor.use($prose(() => search()));
    // Registered after Crepe's own features so these schemas win the node ids.
    crepe.editor.use(imageAltFix);
    crepe.editor.use(tightBulletLists);

    // Crepe preserves blank lines by serializing them as literal `<br />`
    // HTML. Drop that plugin so documents save as standard markdown —
    // real blank lines and backslash/`break` hard breaks, no stray tags.
    await crepe.editor.remove(remarkPreserveEmptyLinePlugin);
    await crepe.create();
    this.crepe = crepe;
    this.setSpellcheck(this.spellcheckOn);
  }

  // ------------------------------------------------------------- mermaid
  private mermaidSeq = 0;
  private mermaidTheme: "dark" | "default" = "dark";

  /** Re-render diagrams when the app theme flips. */
  setMermaidTheme(light: boolean) {
    const next = light ? "default" : "dark";
    if (next === this.mermaidTheme) return;
    this.mermaidTheme = next;
    // Cheapest reliable way to re-run the code-block previews.
    if (this.crepe && (this._mode === "rich" || this.split)) {
      const md = this.crepe.getMarkdown();
      if (md.includes("```mermaid")) {
        this.crepe.editor.action(replaceAll(md, true));
      }
    }
  }

  private renderMermaid(
    language: string,
    content: string,
    applyPreview: (v: string | HTMLElement | null) => void,
  ): string | HTMLElement | null | undefined {
    if (language?.toLowerCase() !== "mermaid") return null; // not a diagram
    if (!content.trim()) {
      applyPreview(null);
      return undefined;
    }
    const id = `mmd-${(this.mermaidSeq++).toString(36)}`;
    const theme = this.mermaidTheme;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
        const { svg } = await mermaid.render(id, content);
        applyPreview(svg);
      } catch (e) {
        const pre = document.createElement("pre");
        pre.className = "mermaid-error";
        pre.textContent = String((e as Error)?.message ?? e);
        applyPreview(pre);
      }
    })();
    return undefined; // async — shows the loading placeholder until applyPreview
  }

  // -------------------------------------------------------------- export

  /** Render the document to standalone HTML (images inlined as data URLs). */
  async toHtml(title: string): Promise<string> {
    if (!this.crepe) return "";
    // In plain source mode the rich document may be stale — refresh it first.
    if (this._mode === "source" && !this.split) {
      this.crepe.editor.action(replaceAll(this.sourceEl.value, true));
    }
    const body = this.crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const serializer = DOMSerializer.fromSchema(view.state.schema);
      const frag = serializer.serializeFragment(view.state.doc.content);
      const holder = document.createElement("div");
      holder.appendChild(frag);
      return holder;
    });
    // Inline local images so the export is a single portable file.
    await Promise.all(
      [...body.querySelectorAll("img")].map(async (img) => {
        const src = img.getAttribute("src") ?? "";
        if (/^(https?:|data:)/i.test(src)) return;
        try {
          img.setAttribute("src", await this.resolveUrl(src));
        } catch {
          /* leave the relative path */
        }
      }),
    );
    for (const el of body.querySelectorAll("[contenteditable]")) {
      el.removeAttribute("contenteditable");
    }
    return htmlDocument(title, body.innerHTML);
  }

  // ------------------------------------------------------------ find/replace
  /** Source-mode match ranges + current index. */
  private srcMatches: Array<[number, number]> = [];
  private srcIndex = -1;

  private view() {
    return this.crepe?.editor.action((ctx) => ctx.get(editorViewCtx)) ?? null;
  }

  /** Start/update a search in the active surface. Returns {count, index}. */
  find(term: string, opts: FindOptions = {}): { count: number; index: number } {
    if (this._mode === "source") return this.srcFind(term, opts);
    const view = this.view();
    if (!view) return { count: 0, index: 0 };
    const query = new SearchQuery({
      search: term,
      caseSensitive: opts.caseSensitive ?? false,
      wholeWord: opts.wholeWord ?? false,
      replace: opts.replace ?? "",
    });
    view.dispatch(setSearchState(view.state.tr, query));
    return this.matchInfo();
  }

  findNext(forward = true): { count: number; index: number } {
    if (this._mode === "source") return this.srcStep(forward);
    const view = this.view();
    if (!view) return { count: 0, index: 0 };
    (forward ? findNext : findPrev)(view.state, view.dispatch, view);
    view.focus();
    return this.matchInfo();
  }

  replaceOne(): { count: number; index: number } {
    if (this._mode === "source") return this.srcReplaceOne();
    const view = this.view();
    if (!view) return { count: 0, index: 0 };
    replaceNext(view.state, view.dispatch, view);
    view.focus();
    this.scheduleSave();
    return this.matchInfo();
  }

  replaceAllMatches(): number {
    if (this._mode === "source") return this.srcReplaceAll();
    const view = this.view();
    if (!view) return 0;
    const before = this.matchInfo().count;
    pmReplaceAll(view.state, view.dispatch, view);
    this.scheduleSave();
    this.onChanged?.();
    return before;
  }

  clearFind() {
    this.srcMatches = [];
    this.srcIndex = -1;
    if (this._mode === "rich") {
      const view = this.view();
      if (view) {
        view.dispatch(setSearchState(view.state.tr, new SearchQuery({ search: "" })));
      }
    }
  }

  private matchInfo(): { count: number; index: number } {
    const view = this.view();
    if (!view) return { count: 0, index: 0 };
    const s = getSearchState(view.state);
    if (!s || !s.query.valid) return { count: 0, index: 0 };
    const range = s.range ?? { from: 0, to: view.state.doc.content.size };
    const { from: selFrom, to: selTo } = view.state.selection;
    let count = 0;
    let index = 0;
    for (let pos = range.from; ; ) {
      const next = s.query.findNext(view.state, pos, range.to);
      if (!next) break;
      count++;
      if (next.from === selFrom && next.to === selTo) index = count;
      pos = Math.max(next.to, pos + 1);
      if (count > 5000) break; // pathological documents: stop counting
    }
    return { count, index };
  }

  // --- source-mode (textarea) find/replace ---
  private srcQuery = "";
  private srcReplace = "";
  private srcCaseSensitive = false;
  private srcWholeWord = false;

  private srcRegex(): RegExp | null {
    if (!this.srcQuery) return null;
    let source = escapeRe(this.srcQuery);
    if (this.srcWholeWord) source = `\\b(?:${source})\\b`;
    try {
      return new RegExp(source, this.srcCaseSensitive ? "g" : "gi");
    } catch {
      return null;
    }
  }

  private srcFind(term: string, opts: FindOptions) {
    this.srcQuery = term;
    this.srcReplace = opts.replace ?? "";
    this.srcCaseSensitive = opts.caseSensitive ?? false;
    this.srcWholeWord = opts.wholeWord ?? false;
    this.srcMatches = [];
    this.srcIndex = -1;
    const re = this.srcRegex();
    if (!re) return { count: 0, index: 0 };
    for (let m = re.exec(this.sourceEl.value); m; m = re.exec(this.sourceEl.value)) {
      this.srcMatches.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) re.lastIndex++; // never loop on an empty match
    }
    if (this.srcMatches.length) this.srcStep(true);
    return { count: this.srcMatches.length, index: this.srcIndex + 1 };
  }

  private srcStep(forward: boolean) {
    if (!this.srcMatches.length) return { count: 0, index: 0 };
    this.srcIndex = forward
      ? (this.srcIndex + 1) % this.srcMatches.length
      : (this.srcIndex - 1 + this.srcMatches.length) % this.srcMatches.length;
    const [a, b] = this.srcMatches[this.srcIndex];
    this.sourceEl.focus();
    this.sourceEl.setSelectionRange(a, b);
    const ratio = a / Math.max(1, this.sourceEl.value.length);
    this.sourceEl.scrollTop = Math.max(
      0,
      ratio * this.sourceEl.scrollHeight - this.sourceEl.clientHeight / 2,
    );
    return { count: this.srcMatches.length, index: this.srcIndex + 1 };
  }

  private srcReplaceOne() {
    if (this.srcIndex < 0 || !this.srcMatches[this.srcIndex])
      return { count: this.srcMatches.length, index: this.srcIndex + 1 };
    const [a, b] = this.srcMatches[this.srcIndex];
    const ta = this.sourceEl;
    ta.value = ta.value.slice(0, a) + this.srcReplace + ta.value.slice(b);
    this.scheduleSave();
    if (this.split) this.schedulePreview();
    this.onChanged?.();
    return this.srcFind(this.srcQuery, {
      replace: this.srcReplace,
      caseSensitive: this.srcCaseSensitive,
      wholeWord: this.srcWholeWord,
    });
  }

  private srcReplaceAll(): number {
    const re = this.srcRegex();
    if (!re) return 0;
    const count = this.srcMatches.length;
    this.sourceEl.value = this.sourceEl.value.replace(re, this.srcReplace);
    this.srcMatches = [];
    this.srcIndex = -1;
    this.scheduleSave();
    if (this.split) this.schedulePreview();
    this.onChanged?.();
    return count;
  }
}

/** Wrap serialized body HTML in a self-contained, readable document. */
function htmlDocument(title: string, body: string): string {
  const esc = (s: string) =>
    s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0 auto; padding: 48px 24px 96px; max-width: 720px;
    font: 16px/1.65 Georgia, "Times New Roman", serif;
    color: #1f1e1d; background: #faf9f5;
  }
  h1, h2, h3, h4, h5, h6 {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    letter-spacing: -0.01em; line-height: 1.25; margin: 1.6em 0 0.4em;
  }
  h1 { font-size: 2em; }
  p, ul, ol, blockquote, table, pre { margin: 0.9em 0; }
  a { color: #b3502f; }
  code { font: 0.88em ui-monospace, "SF Mono", Menlo, monospace;
         background: rgba(0,0,0,.06); padding: .15em .35em; border-radius: 4px; }
  pre { background: rgba(0,0,0,.06); padding: 14px 16px; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin-left: 0; padding-left: 16px; border-left: 3px solid #d97757; color: #3d3d3a; }
  img { max-width: 100%; height: auto; border-radius: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: .95em; }
  th, td { border: 1px solid rgba(0,0,0,.15); padding: 7px 10px; text-align: left; }
  th { background: rgba(0,0,0,.04); }
  hr { border: none; border-top: 1px solid rgba(0,0,0,.15); margin: 2em 0; }
  @media (prefers-color-scheme: dark) {
    body { color: #faf9f5; background: #20201f; }
    a { color: #e08862; }
    code, pre { background: rgba(255,255,255,.08); }
    blockquote { color: #c3c2b7; }
    th, td { border-color: rgba(255,255,255,.15); }
    th { background: rgba(255,255,255,.05); }
    hr { border-top-color: rgba(255,255,255,.15); }
  }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
