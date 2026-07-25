import uFuzzy from "@leeoniya/ufuzzy";

export interface PaletteItem {
  title: string;
  /** Secondary text (relative path, shortcut hint…). */
  subtitle?: string;
  /** Leading glyph (emoji or short text). */
  glyph?: string;
  run: () => void | Promise<void>;
}

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
  files: "Go to file…   (type > for commands, # for headings)",
  commands: "Run a command…",
  outline: "Go to heading…",
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
        <input class="palette-input" spellcheck="false" autocomplete="off" placeholder="" />
        <div class="palette-list" role="listbox"></div>
      </div>`;
    this.input = this.el.querySelector(".palette-input")!;
    this.listEl = this.el.querySelector(".palette-list")!;
    document.body.appendChild(this.el);

    this.el.addEventListener("mousedown", (e) => {
      if (e.target === this.el) this.close(); // click backdrop
    });
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
        (it.title + " " + (it.subtitle ?? "")).toLowerCase(),
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
      const glyph = it.glyph ?? "";
      row.innerHTML =
        `<span class="palette-glyph"></span>` +
        `<span class="palette-title"></span>` +
        (it.subtitle ? `<span class="palette-sub"></span>` : "");
      row.querySelector(".palette-glyph")!.textContent = glyph;
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
    rows.forEach((r, i) => r.classList.toggle("active", i === this.active));
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
