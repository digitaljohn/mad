import uFuzzy from "@leeoniya/ufuzzy";

export interface PaletteItem {
  title: string;
  /** Secondary text (relative path, shortcut hint…). */
  subtitle?: string;
  /** Leading icon as an SVG string. Trusted — always one of our own constants. */
  icon?: string;
  /** Extra text to match against, when the display text isn't the whole story
      (a file row shows its folder but should still match on its full path). */
  search?: string;
  run: () => void | Promise<void>;
}

/** `</>` — commands, matching the mark Claude Code uses for the same idea. */
export const ICON_COMMAND = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 5 2.5 8l3 3"/><path d="M10.5 5l3 3-3 3"/><path d="M9.2 3.6 6.8 12.4"/></svg>`;
/** `#` — headings in the current document. */
export const ICON_HEADING = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M6.2 2.6 4.6 13.4M11.4 2.6 9.8 13.4M3.3 6h9.4M2.7 10h9.4"/></svg>`;
const ICON_SEARCH = `<svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.8" cy="8.8" r="5.6"/><path d="M13 13l4 4"/></svg>`;
const ICON_CLOSE = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg>`;
/** The ⏎ affordance on the highlighted row. */
const ICON_ENTER = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3.5v4a2 2 0 0 1-2 2H3"/><path d="M5.8 7.1 3 9.6l2.8 2.5"/></svg>`;

export interface PaletteProviders {
  /** Default mode (no prefix) — Quick Open files. */
  files: () => Promise<PaletteItem[]> | PaletteItem[];
  /** `>` mode — commands. */
  commands: () => PaletteItem[];
  /** `#` mode — headings in the current document. */
  outline: () => PaletteItem[];
}

type Mode = "files" | "commands" | "outline";

const PLACEHOLDER: Record<Mode, string> = {
  files: "Search files and commands",
  commands: "Run a command",
  outline: "Go to a heading",
};

export class CommandPalette {
  private el: HTMLDivElement;
  private input: HTMLInputElement;
  private listEl: HTMLDivElement;
  private uf = new uFuzzy({ intraMode: 1 });
  private items: PaletteItem[] = [];
  private shown: PaletteItem[] = [];
  private active = 0;
  private open = false;
  /** Per-open item cache so we don't re-walk the folder on every keystroke. */
  private cache = new Map<Mode, Promise<PaletteItem[]>>();
  private token = 0;

  constructor(private providers: PaletteProviders) {
    this.el = document.createElement("div");
    this.el.className = "palette hidden";
    this.el.innerHTML = `
      <div class="palette-box" role="dialog" aria-modal="true">
        <div class="palette-head">
          <span class="palette-search-icon" aria-hidden="true">${ICON_SEARCH}</span>
          <input class="palette-input" spellcheck="false" autocomplete="off" placeholder="" />
          <button class="palette-close" aria-label="Close">${ICON_CLOSE}</button>
        </div>
        <div class="palette-list" role="listbox"></div>
      </div>`;
    this.input = this.el.querySelector(".palette-input")!;
    this.listEl = this.el.querySelector(".palette-list")!;
    document.body.appendChild(this.el);

    this.el.addEventListener("mousedown", (e) => {
      if (e.target === this.el) this.close(); // click backdrop
    });
    this.el.querySelector(".palette-close")!.addEventListener("click", () => this.close());
    this.input.addEventListener("input", () => void this.refresh());
    this.input.addEventListener("keydown", (e) => this.onKey(e));
  }

  private modeOf(value: string): { mode: Mode; needle: string } {
    if (value.startsWith(">")) return { mode: "commands", needle: value.slice(1).trim() };
    if (value.startsWith("#")) return { mode: "outline", needle: value.slice(1).trim() };
    return { mode: "files", needle: value.trim() };
  }

  /** Open the palette. `seed` sets the initial input (e.g. ">" or "#"). */
  async show(seed = "") {
    this.open = true;
    this.cache.clear(); // fresh data each open
    this.el.classList.remove("hidden");
    this.input.value = seed;
    this.input.focus();
    await this.refresh();
  }

  close() {
    this.open = false;
    this.el.classList.add("hidden");
    this.input.value = "";
    this.listEl.innerHTML = "";
  }

  get isOpen() {
    return this.open;
  }

  private async loadItems(mode: Mode): Promise<PaletteItem[]> {
    if (mode === "commands") return this.providers.commands();
    if (mode === "outline") return this.providers.outline();
    return this.providers.files();
  }

  private async refresh() {
    const value = this.input.value;
    const { mode, needle } = this.modeOf(value);
    this.input.placeholder = PLACEHOLDER[mode];
    const myToken = ++this.token;
    // Load the mode's items once per open; reuse for subsequent keystrokes.
    if (!this.cache.has(mode)) {
      this.cache.set(mode, Promise.resolve(this.loadItems(mode)));
    }
    this.items = await this.cache.get(mode)!;
    if (!this.open || myToken !== this.token) return; // stale / closed

    if (!needle) {
      this.shown = this.items.slice(0, 200);
    } else {
      const hay = this.items.map((it) =>
        (it.title + " " + (it.search ?? it.subtitle ?? "")).toLowerCase(),
      );
      const [idxs, info, order] = this.uf.search(hay, needle.toLowerCase());
      if (order && info) {
        this.shown = order.map((o) => this.items[info.idx[o]]);
      } else if (idxs) {
        this.shown = idxs.map((i) => this.items[i]);
      } else {
        this.shown = [];
      }
      this.shown = this.shown.slice(0, 200);
    }
    this.active = 0;
    this.renderList();
  }

  private renderList() {
    this.listEl.innerHTML = "";
    if (this.shown.length === 0) {
      const empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent = "No matches";
      this.listEl.appendChild(empty);
      return;
    }
    this.shown.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "palette-item" + (i === this.active ? " active" : "");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === this.active));
      row.innerHTML =
        `<span class="palette-glyph" aria-hidden="true">${it.icon ?? ""}</span>` +
        `<span class="palette-title"></span>` +
        (it.subtitle ? `<span class="palette-sub"></span>` : "") +
        `<span class="palette-enter" aria-hidden="true">${ICON_ENTER}</span>`;
      row.querySelector(".palette-title")!.textContent = it.title;
      if (it.subtitle) row.querySelector(".palette-sub")!.textContent = it.subtitle;
      row.addEventListener("mousemove", () => {
        if (this.active !== i) {
          this.active = i;
          this.highlight();
        }
      });
      row.addEventListener("click", () => this.choose(i));
      this.listEl.appendChild(row);
    });
    this.highlight();
  }

  private highlight() {
    const rows = [...this.listEl.querySelectorAll<HTMLElement>(".palette-item")];
    rows.forEach((r, i) => {
      const on = i === this.active;
      r.classList.toggle("active", on);
      r.setAttribute("aria-selected", String(on));
    });
    rows[this.active]?.scrollIntoView({ block: "nearest" });
  }

  private choose(i: number) {
    const it = this.shown[i];
    if (!it) return;
    this.close();
    void it.run();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      // The window handler also acts on Escape (find bar, diff panel) —
      // closing a modal must not close things behind it too.
      e.stopPropagation();
      this.close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      this.active = Math.min(this.active + 1, this.shown.length - 1);
      this.highlight();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.active = Math.max(this.active - 1, 0);
      this.highlight();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.choose(this.active);
    }
  }
}
