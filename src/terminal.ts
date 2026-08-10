// The terminal panel: xterm.js in front, a real PTY behind the IPC bridge.
//
// The shell exists only while the panel does — nothing is spawned until the
// user asks for a terminal, and closing the panel kills it. Output arrives
// as base64 bytes (a PTY read can split a UTF-8 sequence; the emulator does
// its own decoding), keystrokes go back as plain strings.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Backend } from "./backend";

export interface TerminalCallbacks {
  /** Output arrived — whatever ran may have touched files or git state. */
  onActivity?: () => void;
  /** The shell ended (exit, ⌃D, crash). */
  onExit?: () => void;
}

/** Claude palette, hand-mapped for the two app themes. Only the surfaces
    are pinned; ANSI colors stay xterm's defaults, which read well on both. */
const DARK_THEME = {
  background: "#1b1b1a",
  foreground: "#faf9f5",
  cursor: "#d97757",
  cursorAccent: "#1b1b1a",
  selectionBackground: "rgba(42, 120, 214, 0.35)",
};
const LIGHT_THEME = {
  background: "#f7f5ee",
  foreground: "#1f1e1d",
  cursor: "#c6613f",
  cursorAccent: "#f7f5ee",
  selectionBackground: "rgba(42, 120, 214, 0.22)",
};

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class TerminalPanel {
  private term: Terminal;
  private fit: FitAddon;
  /** Backend PTY id; null before start and after the shell exits. */
  private id: number | null = null;
  /** Events that raced ahead of the term_open response — the first chunk
      of shell output can beat the id across the bridge. Replayed in order
      the moment the id is known. */
  private pending: Array<{ id: number; data?: string }> = [];
  private starting = false;

  constructor(
    host: HTMLElement,
    private backend: Backend,
    private cb: TerminalCallbacks = {},
  ) {
    this.term = new Terminal({
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue("--font-mono") ||
        "ui-monospace, Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: document.documentElement.classList.contains("light")
        ? LIGHT_THEME
        : DARK_THEME,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(host);
    this.term.onData((d) => {
      if (this.id !== null) void this.backend.termWrite(this.id, d).catch(() => {});
    });
  }

  /** Spawn the shell (in `cwd` when given) and connect it to the screen. */
  async start(cwd: string | null, focus = true): Promise<void> {
    this.fit.fit();
    this.starting = true;
    try {
      this.id = await this.backend.termOpen(cwd, this.term.cols, this.term.rows);
    } finally {
      this.starting = false;
    }
    const held = this.pending;
    this.pending = [];
    for (const ev of held) {
      if (ev.data !== undefined) this.receive(ev.id, ev.data);
      else this.exited(ev.id);
    }
    if (focus) this.term.focus();
  }

  get running(): boolean {
    return this.id !== null;
  }

  /** A chunk of PTY output addressed to terminal `id`. */
  receive(id: number, dataB64: string) {
    if (this.starting) {
      this.pending.push({ id, data: dataB64 });
      return;
    }
    if (id !== this.id) return; // an old shell's tail, not ours
    this.term.write(b64ToBytes(dataB64));
    this.cb.onActivity?.();
  }

  /** The backend says shell `id` ended. */
  exited(id: number) {
    if (this.starting) {
      this.pending.push({ id });
      return;
    }
    if (id !== this.id) return;
    this.id = null;
    this.term.write("\r\n\x1b[2m[shell exited — reopen the terminal for a new one]\x1b[0m\r\n");
    this.cb.onExit?.();
  }

  /** Refit to the panel and tell the PTY, so the shell reflows. */
  resize() {
    // Fitting a hidden panel computes garbage dimensions — skip.
    if (!this.term.element?.offsetParent) return;
    this.fit.fit();
    if (this.id !== null) {
      void this.backend.termResize(this.id, this.term.cols, this.term.rows).catch(() => {});
    }
  }

  setTheme(light: boolean) {
    this.term.options.theme = light ? LIGHT_THEME : DARK_THEME;
  }

  focus() {
    this.term.focus();
  }

  /** Kill the shell and release the emulator. The panel is done. */
  async dispose(): Promise<void> {
    const id = this.id;
    this.id = null;
    this.term.dispose();
    if (id !== null) await this.backend.termClose(id).catch(() => {});
  }
}
