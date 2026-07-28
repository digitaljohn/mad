import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkForUpdates,
  formatBytes,
  progressLine,
  resetUpdaterState,
  shortNotes,
} from "./updater";

const toasts = () =>
  [...document.querySelectorAll(".toast:not(.leaving) .toast-text")].map(
    (t) => t.textContent,
  );
const liveToasts = () => document.querySelectorAll(".toast:not(.leaving)");

// The plugins only exist inside the app, so stand in for them. `checkForUpdates`
// imports them dynamically, which is what makes this mockable at all.
const check = vi.fn();
const relaunch = vi.fn(async () => {});
vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => check() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunch() }));

type Confirm = (t: string, m: string, ok: string, cancel: string) => Promise<boolean>;
const yes = { confirm: vi.fn<Confirm>(async () => true) };
const no = { confirm: vi.fn<Confirm>(async () => false) };

beforeEach(() => {
  resetUpdaterState();
  check.mockReset();
  relaunch.mockClear();
  yes.confirm.mockClear();
  no.confirm.mockClear();
});

describe("formatBytes", () => {
  it("scales the unit to the size", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4096)).toBe("4 KB");
    expect(formatBytes(13_400_000)).toBe("12.8 MB");
  });

  it("does not report 0.0 MB for something under a megabyte", () => {
    expect(formatBytes(900_000)).toMatch(/KB$/);
  });
});

describe("progressLine", () => {
  it("shows a percentage once the total is known", () => {
    expect(progressLine(5_000_000, 10_000_000)).toBe(
      "Downloading update… 50% of 9.5 MB",
    );
  });

  it("falls back to bytes when the server sent no length", () => {
    expect(progressLine(2048, null)).toBe("Downloading update… 2 KB");
  });

  it("never exceeds 100%, even if the chunks overshoot", () => {
    expect(progressLine(11_000_000, 10_000_000)).toContain("100%");
  });
});

describe("shortNotes", () => {
  it("passes short notes through, trimmed", () => {
    expect(shortNotes("  Fixed a thing.  ")).toBe("Fixed a thing.");
  });

  it("truncates long notes so a dialog stays a dialog", () => {
    const long = "x".repeat(900);
    const out = shortNotes(long);
    expect(out.length).toBeLessThan(420);
    expect(out.endsWith("…")).toBe(true);
  });

  it("copes with no notes at all", () => {
    expect(shortNotes(undefined)).toBe("");
  });

  it("cuts on a line boundary rather than mid-word", () => {
    const notes = `${"a".repeat(300)}\n• ${"b".repeat(300)}`;
    expect(shortNotes(notes)).toBe(`${"a".repeat(300)}…`);
  });

  it("falls back to a word boundary when there is no line to cut on", () => {
    const notes = `${"word ".repeat(90)}end`;
    const out = shortNotes(notes);
    expect(out.endsWith("word…")).toBe(true);
  });

  it("does not leave a heading dangling with nothing under it", () => {
    // The real shape: a blank line under the heading, so the cut lands on a
    // newline *after* the colon rather than on the colon itself.
    const notes = `${"a".repeat(300)}\n\nFixed:\n\n• ${"b".repeat(300)}`;
    expect(shortNotes(notes)).toBe(`${"a".repeat(300)}…`);
  });

  it("ignores a boundary too near the start to be worth honouring", () => {
    // One early newline, then an unbroken run: cutting at the newline would
    // throw away 390 of the 400 characters that fit.
    const out = shortNotes(`a\n${"b".repeat(600)}`);
    expect(out).toBe(`a\n${"b".repeat(398)}…`);
  });
});

describe("checkForUpdates", () => {
  it("says so when already up to date", async () => {
    check.mockResolvedValue(null);
    await checkForUpdates(yes);
    expect(toasts()).toContain("mad is up to date");
    expect(yes.confirm).not.toHaveBeenCalled();
  });

  it("stays quiet when up to date and asked to be silent", async () => {
    check.mockResolvedValue(null);
    await checkForUpdates(yes, { silent: true });
    expect(toasts()).toEqual([]);
  });

  it("asks before downloading, and does nothing if declined", async () => {
    const downloadAndInstall = vi.fn();
    check.mockResolvedValue({ version: "0.3.0", body: "Notes", downloadAndInstall });
    await checkForUpdates(no);
    expect(no.confirm).toHaveBeenCalledOnce();
    expect(no.confirm.mock.calls[0][0]).toContain("0.3.0");
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("downloads, reports progress, then relaunches", async () => {
    const downloadAndInstall = vi.fn(async (onEvent) => {
      onEvent({ event: "Started", data: { contentLength: 10_000_000 } });
      onEvent({ event: "Progress", data: { chunkLength: 2_500_000 } });
      onEvent({ event: "Progress", data: { chunkLength: 2_500_000 } });
      onEvent({ event: "Finished", data: {} });
    });
    check.mockResolvedValue({ version: "0.3.0", body: "", downloadAndInstall });

    await checkForUpdates(yes);

    expect(downloadAndInstall).toHaveBeenCalledOnce();
    // The progress toast is reused, not recreated per chunk.
    expect(liveToasts()).toHaveLength(1);
    expect(toasts()[0]).toBe("Restarting…");
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("copes with a download that never reports a length", async () => {
    const downloadAndInstall = vi.fn(async (onEvent) => {
      onEvent({ event: "Started" }); // no data at all
      onEvent({ event: "Started", data: {} });
      onEvent({ event: "Progress", data: { chunkLength: 1024 } });
      onEvent({ event: "Progress", data: {} }); // a chunk event with no size
      onEvent({ event: "Finished" }); // Finished carries no data at all
    });
    check.mockResolvedValue({ version: "0.3.0", downloadAndInstall });
    await checkForUpdates(yes);
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("ignores a second Update click while the download runs", async () => {
    let release!: () => void;
    const downloadAndInstall = vi.fn(
      () => new Promise<void>((r) => (release = () => r())),
    );
    check.mockResolvedValue({ version: "0.3.0", body: "", downloadAndInstall });
    await checkForUpdates(yes, { silent: true });

    const action = document.querySelector<HTMLButtonElement>(".toast-action")!;
    action.click();
    action.click(); // double-click must not start a second download
    await vi.waitFor(() => expect(downloadAndInstall).toHaveBeenCalled());
    expect(downloadAndInstall).toHaveBeenCalledOnce();
    release();
  });

  it("reports a failed check, but only when not silent", async () => {
    check.mockRejectedValue(new Error("network down"));
    await checkForUpdates(yes, { silent: true });
    expect(toasts()).toEqual([]);

    await checkForUpdates(yes);
    expect(toasts().some((t) => t?.includes("network down"))).toBe(true);
  });

  it("does not leave the checking toast on screen after a failure", async () => {
    check.mockRejectedValue(new Error("boom"));
    await checkForUpdates(yes);
    expect(toasts()).not.toContain("Checking for updates…");
  });

  it("dismisses the progress toast when the download itself fails", async () => {
    const downloadAndInstall = vi.fn(async (onEvent) => {
      onEvent({ event: "Started", data: { contentLength: 10_000_000 } });
      onEvent({ event: "Progress", data: { chunkLength: 2_500_000 } });
      throw new Error("connection reset");
    });
    check.mockResolvedValue({ version: "0.3.0", body: "", downloadAndInstall });

    await checkForUpdates(yes);

    // No zombie "Downloading update…" toast pinned forever…
    expect(toasts().some((t) => t?.includes("Downloading update"))).toBe(false);
    // …and the user is told the download failed, even on a silent check.
    expect(toasts().some((t) => t?.includes("connection reset"))).toBe(true);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("offers a silent-check update as a toast, never a modal", async () => {
    const downloadAndInstall = vi.fn(async () => {});
    check.mockResolvedValue({ version: "0.3.0", body: "", downloadAndInstall });

    await checkForUpdates(yes, { silent: true });

    // No dialog four seconds into the session…
    expect(yes.confirm).not.toHaveBeenCalled();
    expect(downloadAndInstall).not.toHaveBeenCalled();
    // …just a pinned toast with an Update button.
    expect(toasts().some((t) => t?.includes("0.3.0 is available"))).toBe(true);
    const action = document.querySelector<HTMLButtonElement>(".toast-action");
    expect(action?.textContent).toBe("Update");

    // Clicking it starts the download; a failure is reported even though the
    // original check was silent — the user explicitly chose this download.
    downloadAndInstall.mockRejectedValueOnce(new Error("disk full"));
    action!.click();
    await vi.waitFor(() =>
      expect(toasts().some((t) => t?.includes("disk full"))).toBe(true),
    );
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("ignores a second check while one is in flight", async () => {
    let release!: () => void;
    check.mockImplementation(() => new Promise((r) => (release = () => r(null))));
    const first = checkForUpdates(yes);
    // `check` is reached only after a dynamic import resolves, so wait for it
    // before trying to release it.
    await vi.waitFor(() => expect(check).toHaveBeenCalled());
    await checkForUpdates(yes); // must be a no-op, not a second check
    release();
    await first;
    expect(check).toHaveBeenCalledOnce();
  });

  it("becomes available again after finishing", async () => {
    check.mockResolvedValue(null);
    await checkForUpdates(yes);
    await checkForUpdates(yes);
    expect(check).toHaveBeenCalledTimes(2);
  });
});
