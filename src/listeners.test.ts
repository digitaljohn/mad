// Every window-scoped event listener must name its window.
//
// This is a source-level guard, which is unusual here — but it pins the exact
// layer that shipped this bug twice. Tauri's `listen()` defaults to
// `EventTarget::Any`, and an Any listener bypasses the emit filter outright
// (tauri listener.rs: `*target == EventTarget::Any || filter(..)`). So a
// Rust-side `emit_to("mad-2", ..)` is delivered to EVERY window that
// subscribed without naming one — File ▸ Open Folder opened the folder in
// all of them, and one window's `fs-change` reloaded another's tabs.
//
// The routing decision is already covered by `choose_menu_target` on the Rust
// side, and it was correct both times. What was untested is whether the label
// it chooses survives delivery, which lives in main.ts — a file jsdom cannot
// execute (Crepe, dynamic `@tauri-apps/*` imports) and coverage excludes.
// Reading the source is what's left, and it catches the next listener someone
// adds as well as the ones here now.

import { describe, expect, it } from "vitest";

// Vite's `?raw` hands back the file as text without executing it — which
// matters, because main.ts cannot run under jsdom. The declaration for it
// comes from `vite/client`, already in tsconfig's `types`, so this needs no
// Node typings.
import SRC from "./main.ts?raw";

/** Events that are genuinely meant for every window, and say so. */
const BROADCAST = new Set([
  "flush-and-exit", // ⌘Q must ask every window before the app exits
  "prefs-changed", // a shared preference changed; all windows adopt it
]);

interface Call {
  /** The event name, when the first argument is a string literal. */
  event: string | null;
  /** The full source text of the call, parens balanced. */
  text: string;
}

/**
 * Blank out comments and string bodies, keeping every byte offset intact so
 * the scan below still lines up with the original source. Without this the
 * scanner reads prose: the comment above `mine` in main.ts mentions
 * `listen()`, and that is not a call site.
 */
function code(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < out.length; j++) {
      if (out[j] !== "\n") out[j] = " ";
    }
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      // Step over the literal without touching it — the event names live in
      // these, and a "https://…" inside one must not read as a comment.
      const quote = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== quote) j += src[j] === "\\" ? 2 : 1;
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Every `listen(...)` / `listen<T>(...)` call in main.ts, parens balanced. */
function listenCalls(src: string): Call[] {
  const calls: Call[] = [];
  const start = /\blisten\s*(?:<[^>]*>)?\s*\(/g;
  for (let m = start.exec(src); m; m = start.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    const text = src.slice(m.index, i);
    const literal = /^\s*\(\s*["'`]([^"'`]+)["'`]/.exec(
      text.slice(text.indexOf("(")),
    );
    calls.push({ event: literal?.[1] ?? null, text });
  }
  return calls;
}

describe("event listener scoping", () => {
  const calls = listenCalls(code(SRC));

  it("finds the listeners at all, so a rename can't silently pass this file", () => {
    // The probe run had 8; if this ever drops to 0 the regex has rotted and
    // every assertion below would vacuously pass.
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });

  it("scopes every listener that is not a deliberate broadcast", () => {
    const unscoped = calls
      .filter((c) => !/\bmine\b/.test(c.text))
      .filter((c) => !(c.event && BROADCAST.has(c.event)))
      .map((c) => c.event ?? c.text.slice(0, 60));
    expect(unscoped).toEqual([]);
  });

  it("leaves the deliberate broadcasts unscoped", () => {
    // Scoping these would be just as wrong in the other direction: ⌘Q has to
    // reach every window, not only the front one.
    for (const name of BROADCAST) {
      const call = calls.find((c) => c.event === name);
      expect(call, `no listener for ${name}`).toBeDefined();
      expect(/\bmine\b/.test(call!.text), `${name} must stay global`).toBe(false);
    }
  });

  it("derives the scope from this window's own label", () => {
    expect(SRC).toMatch(/const mine = \{ target: winLabel \}/);
  });
});
