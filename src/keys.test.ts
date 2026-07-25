import { describe, expect, it } from "vitest";
import { resolveKey, type KeyStroke } from "./keys";

const stroke = (code: string, mods: Partial<KeyStroke> = {}): KeyStroke => ({
  code,
  meta: true,
  ctrl: false,
  shift: false,
  alt: false,
  ...mods,
});

const browser = { native: false, paletteOpen: false };
const native = { native: true, paletteOpen: false };

describe("resolveKey", () => {
  it("ignores keystrokes without a modifier", () => {
    expect(resolveKey(stroke("KeyP", { meta: false }), browser)).toBeNull();
  });

  it("accepts ctrl as the modifier too", () => {
    expect(resolveKey(stroke("KeyP", { meta: false, ctrl: true }), browser)).toEqual({
      kind: "quick-open",
    });
  });

  it("resolves nothing while the palette modal is open", () => {
    // ⌘W over the palette must not close a tab behind it.
    expect(
      resolveKey(stroke("KeyW"), { native: false, paletteOpen: true }),
    ).toBeNull();
    expect(
      resolveKey(stroke("Digit1"), { native: true, paletteOpen: true }),
    ).toBeNull();
  });

  describe("in native mode (a menu owns the app-wide accelerators)", () => {
    it.each([
      "KeyP",
      "KeyF",
      "KeyW",
      "KeyD",
      "KeyO",
      "Backslash",
      "Minus",
      "Digit0",
      "KeyS",
      "KeyN",
      "KeyM",
      "KeyV",
    ])("does not double-handle %s — the menu event already runs it", (code) => {
      expect(resolveKey(stroke(code), native)).toBeNull();
      expect(resolveKey(stroke(code, { shift: true }), native)).toBeNull();
    });

    it("does not double-handle plain ⌘= but claims the ⌘⇧= variant", () => {
      // The menu registers only "CmdOrCtrl+=", so ⌘⇧= would otherwise be dead.
      expect(resolveKey(stroke("Equal"), native)).toBeNull();
      expect(resolveKey(stroke("Equal", { shift: true }), native)).toEqual({
        kind: "zoom",
        delta: 1,
      });
    });

    it("still resolves the bindings that have no menu item", () => {
      expect(resolveKey(stroke("Digit3"), native)).toEqual({
        kind: "tab-digit",
        digit: 3,
      });
      expect(resolveKey(stroke("ArrowRight", { alt: true }), native)).toEqual({
        kind: "tab-cycle",
        dir: 1,
      });
      expect(resolveKey(stroke("ArrowLeft", { alt: true }), native)).toEqual({
        kind: "tab-cycle",
        dir: -1,
      });
      expect(resolveKey(stroke("KeyK"), native)).toEqual({ kind: "palette" });
    });
  });

  describe("in the browser (no native menu exists)", () => {
    it.each([
      ["KeyP", {}, { kind: "quick-open" }],
      ["KeyP", { shift: true }, { kind: "palette" }],
      ["KeyK", {}, { kind: "palette" }],
      ["KeyF", {}, { kind: "find" }],
      ["KeyF", { alt: true }, { kind: "find-replace" }],
      ["KeyF", { shift: true }, { kind: "search-files" }],
      ["KeyO", { shift: true }, { kind: "goto-heading" }],
      ["Equal", { shift: true }, { kind: "zoom", delta: 1 }],
      ["KeyW", {}, { kind: "close-tab" }],
      ["KeyD", { shift: true }, { kind: "show-diff" }],
      ["Backslash", {}, { kind: "toggle-sidebar" }],
      ["Equal", {}, { kind: "zoom", delta: 1 }],
      ["Minus", {}, { kind: "zoom", delta: -1 }],
      ["Digit0", {}, { kind: "zoom", delta: 0 }],
      ["KeyS", {}, { kind: "save" }],
      ["KeyS", { shift: true }, { kind: "save-as" }],
      ["KeyN", {}, { kind: "new-file" }],
      ["KeyN", { shift: true }, { kind: "new-folder" }],
      ["KeyM", { shift: true }, { kind: "toggle-source" }],
      ["KeyV", { shift: true }, { kind: "toggle-split" }],
    ] as const)("maps %s %o", (code, mods, expected) => {
      expect(resolveKey(stroke(code, mods), browser)).toEqual(expected);
    });

    it("maps ⌘1–⌘9 to tab switching", () => {
      expect(resolveKey(stroke("Digit1"), browser)).toEqual({
        kind: "tab-digit",
        digit: 1,
      });
      expect(resolveKey(stroke("Digit9"), browser)).toEqual({
        kind: "tab-digit",
        digit: 9,
      });
    });

    it("requires plain digits — ⌘⇧1 and ⌘⌥1 are not tab switches", () => {
      expect(resolveKey(stroke("Digit1", { shift: true }), browser)).toBeNull();
      expect(resolveKey(stroke("Digit1", { alt: true }), browser)).toBeNull();
    });

    it("keeps modifier variants distinct", () => {
      // ⌘⇧K, ⌘⌥K, ⌘⇧W, ⌘⇧\ are unbound on purpose.
      expect(resolveKey(stroke("KeyK", { shift: true }), browser)).toBeNull();
      expect(resolveKey(stroke("KeyK", { alt: true }), browser)).toBeNull();
      expect(resolveKey(stroke("KeyW", { shift: true }), browser)).toBeNull();
      expect(resolveKey(stroke("Backslash", { shift: true }), browser)).toBeNull();
    });

    it("returns null for unbound keys", () => {
      expect(resolveKey(stroke("KeyQ"), browser)).toBeNull();
      expect(resolveKey(stroke("ArrowLeft"), browser)).toBeNull(); // no alt
    });
  });
});
