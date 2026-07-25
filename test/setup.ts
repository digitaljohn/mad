// Shared jsdom shims. jsdom implements the DOM but not the bits of the CSS and
// layout model that real browsers give us for free, so a handful of methods the
// app calls need stubbing or every test throws on unrelated plumbing.

import { beforeEach, vi } from "vitest";

// Not implemented in jsdom; the tree and palette both scroll the active row.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// jsdom ships no CSS.escape, which the tree needs to look a row up by its path
// (paths are full of characters that are selector syntax). Close enough to the
// spec for attribute selectors: escape anything outside [A-Za-z0-9_-] and
// non-ASCII, and a leading digit.
if (typeof CSS === "undefined" || typeof CSS.escape !== "function") {
  const escape = (value: string) =>
    String(value).replace(/[\s\S]/g, (ch) => {
      const code = ch.codePointAt(0)!;
      if (/[A-Za-z_-]/.test(ch) || code > 0x7f) return ch;
      if (/[0-9]/.test(ch)) return ch;
      return "\\" + ch;
    });
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    writable: true,
    value: { ...(typeof CSS === "undefined" ? {} : CSS), escape },
  });
}

// jsdom's clipboard is read-only and absent under some versions.
if (!navigator.clipboard) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
}

// requestAnimationFrame exists in jsdom but runs on a timer; make it immediate
// so scroll-sync style callbacks resolve within a test tick.
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  cb(0);
  return 0;
}) as typeof requestAnimationFrame;

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.className = "";
  localStorage.clear();
});
