// Keyboard dispatch, as data: one function that maps a keystroke to an app
// action. Extracted from main.ts so the rules — especially which bindings the
// native menu owns — are unit-testable.

export interface KeyStroke {
  code: string;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

export interface KeyContext {
  /** A native menu owns the app-wide accelerators (running under Tauri). */
  native: boolean;
  /** The command palette modal is open and owns the keyboard. */
  paletteOpen: boolean;
}

export type KeyAction =
  | { kind: "tab-digit"; digit: number }
  | { kind: "tab-cycle"; dir: 1 | -1 }
  | { kind: "quick-open" }
  | { kind: "palette" }
  | { kind: "find" }
  | { kind: "find-replace" }
  | { kind: "search-files" }
  | { kind: "goto-heading" }
  | { kind: "close-tab" }
  | { kind: "show-diff" }
  | { kind: "toggle-sidebar" }
  | { kind: "zoom"; delta: 1 | -1 | 0 }
  | { kind: "save" }
  | { kind: "save-as" }
  | { kind: "new-file" }
  | { kind: "new-window" }
  | { kind: "toggle-source" }
  | { kind: "toggle-split" };

/**
 * Resolve a modifier keystroke to an action, or null when nothing should run.
 *
 * Under Tauri (`native`), most of these combinations are *also* native menu
 * accelerators, and the menu event arrives separately — handling the DOM key
 * too would run every action twice (one ⌘W closing two tabs, ⌘\ toggling the
 * sidebar back and forth). So in native mode only the bindings with no menu
 * item resolve here: tab switching and ⌘K.
 */
export function resolveKey(k: KeyStroke, ctx: KeyContext): KeyAction | null {
  const mod = k.meta || k.ctrl;
  if (!mod) return null;
  // The palette is modal: nothing may act on the document behind it.
  if (ctx.paletteOpen) return null;

  const digit = /^Digit([1-9])$/.exec(k.code);
  if (digit && !k.shift && !k.alt) {
    return { kind: "tab-digit", digit: Number(digit[1]) };
  }
  if (k.alt && (k.code === "ArrowLeft" || k.code === "ArrowRight")) {
    return { kind: "tab-cycle", dir: k.code === "ArrowRight" ? 1 : -1 };
  }
  if (k.code === "KeyK" && !k.shift && !k.alt) return { kind: "palette" };
  // ⌘⇧= is muscle-memory for zoom in; the menu only registers plain ⌘=,
  // so this variant is ours to handle even under the native menu.
  if (k.code === "Equal" && k.shift && !k.alt) return { kind: "zoom", delta: 1 };

  if (ctx.native) return null; // the native menu owns everything below

  if (k.code === "KeyP" && k.shift && !k.alt) return { kind: "palette" };
  if (k.code === "KeyP" && !k.shift && !k.alt) return { kind: "quick-open" };
  if (k.code === "KeyF" && k.shift && !k.alt) return { kind: "search-files" };
  if (k.code === "KeyF" && k.alt) return { kind: "find-replace" };
  if (k.code === "KeyF" && !k.shift) return { kind: "find" };
  if (k.code === "KeyO" && k.shift && !k.alt) return { kind: "goto-heading" };
  if (k.code === "KeyW" && !k.shift && !k.alt) return { kind: "close-tab" };
  if (k.code === "KeyD" && k.shift && !k.alt) return { kind: "show-diff" };
  if (k.code === "Backslash" && !k.shift) return { kind: "toggle-sidebar" };
  if (k.code === "Equal") return { kind: "zoom", delta: 1 };
  if (k.code === "Minus") return { kind: "zoom", delta: -1 };
  if (k.code === "Digit0") return { kind: "zoom", delta: 0 };
  if (k.code === "KeyS" && k.shift) return { kind: "save-as" };
  if (k.code === "KeyS") return { kind: "save" };
  // ⇧⌘N is New Window, matching every macOS app where ⌘N already makes a
  // document. New Folder lives in the tree's context menu instead.
  if (k.code === "KeyN" && k.shift) return { kind: "new-window" };
  if (k.code === "KeyN") return { kind: "new-file" };
  if (k.code === "KeyM" && k.shift) return { kind: "toggle-source" };
  if (k.code === "KeyV" && k.shift) return { kind: "toggle-split" };
  return null;
}
