import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast, toastError } from "./toast";

const host = () => document.getElementById("toasts");
const texts = () =>
  [...document.querySelectorAll(".toast-text")].map((e) => e.textContent);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("toast", () => {
  it("creates its host lazily and reuses it", () => {
    expect(host()).toBe(null);
    toast("one");
    const first = host();
    expect(first).not.toBe(null);
    toast("two");
    expect(host()).toBe(first);
    expect(document.querySelectorAll("#toasts")).toHaveLength(1);
  });

  it("announces politely for screen readers", () => {
    toast("hello");
    expect(host()!.getAttribute("role")).toBe("status");
    expect(host()!.getAttribute("aria-live")).toBe("polite");
  });

  it("shows the message as text, never as markup", () => {
    toast("<img src=x onerror=alert(1)>");
    expect(document.querySelector(".toast-text")!.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
    expect(document.querySelector(".toast img")).toBe(null);
  });

  it("stacks several at once", () => {
    toast("a");
    toast("b");
    expect(texts()).toEqual(["a", "b"]);
  });

  it("dismisses itself after the default duration", () => {
    toast("bye");
    expect(texts()).toEqual(["bye"]);
    vi.advanceTimersByTime(3200);
    vi.advanceTimersByTime(200); // removal transition
    expect(texts()).toEqual([]);
  });

  it("gives errors longer on screen than routine messages", () => {
    toast("err", { kind: "error" });
    vi.advanceTimersByTime(3400); // past the normal duration
    expect(texts()).toEqual(["err"]);
    vi.advanceTimersByTime(3000);
    expect(texts()).toEqual([]);
  });

  it("stays until dismissed when the duration is zero", () => {
    toast("sticky", { duration: 0 });
    vi.advanceTimersByTime(60_000);
    expect(texts()).toEqual(["sticky"]);
  });

  it("marks the kind so the stylesheet can colour it", () => {
    toast("a", { kind: "success" });
    expect(document.querySelector(".toast")!.className).toContain("success");
  });

  it("closes on the dismiss button", () => {
    toast("a", { duration: 0 });
    document.querySelector<HTMLButtonElement>(".toast-close")!.click();
    vi.advanceTimersByTime(200);
    expect(texts()).toEqual([]);
  });

  it("returns a handle the caller can dismiss", () => {
    const h = toast("a", { duration: 0 });
    h.dismiss();
    vi.advanceTimersByTime(200);
    expect(texts()).toEqual([]);
  });

  it("does not throw when dismissed twice", () => {
    const h = toast("a", { duration: 0 });
    h.dismiss();
    expect(() => h.dismiss()).not.toThrow();
    vi.advanceTimersByTime(200);
  });

  it("updates its text in place, for progress on long work", () => {
    const h = toast("Downloading… 0%", { duration: 0 });
    h.setText("Downloading… 62%");
    expect(texts()).toEqual(["Downloading… 62%"]);
    // Same element — the toast must not flicker out and back.
    expect(document.querySelectorAll(".toast")).toHaveLength(1);
  });

  it("can change kind, so work that fails turns into an error", () => {
    const h = toast("Working", { duration: 0 });
    expect(document.querySelector(".toast")!.className).toContain("info");
    h.setKind("error");
    const cls = document.querySelector(".toast")!.className;
    expect(cls).toContain("error");
    expect(cls).not.toContain("info");
  });
});

describe("toast actions", () => {
  it("runs the action and dismisses", () => {
    const run = vi.fn();
    toast("undo me", { duration: 0, action: { label: "Undo", run } });
    const btn = document.querySelector<HTMLButtonElement>(".toast-action")!;
    expect(btn.textContent).toBe("Undo");
    btn.click();
    expect(run).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(200);
    expect(texts()).toEqual([]);
  });

  it("has no action button when none was given", () => {
    toast("plain");
    expect(document.querySelector(".toast-action")).toBe(null);
  });
});

describe("toastError", () => {
  it("prefixes the message and reads an Error's text", () => {
    toastError("Couldn’t save", new Error("disk full"));
    expect(texts()).toEqual(["Couldn’t save: disk full"]);
  });

  it("accepts the bare strings Rust commands reject with", () => {
    toastError("Couldn’t move", "already exists");
    expect(texts()).toEqual(["Couldn’t move: already exists"]);
  });

  it("trims the noisy OS error suffix", () => {
    toastError("Couldn’t open", new Error("No such file (os error 2)"));
    expect(texts()).toEqual(["Couldn’t open: No such file"]);
  });

  it("is styled as an error", () => {
    toastError("x", "y");
    expect(document.querySelector(".toast")!.className).toContain("error");
  });
});
