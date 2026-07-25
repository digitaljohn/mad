// Self-update: check, download with progress, install, relaunch.
//
// Everything here is dynamically imported so the module can be loaded in a
// plain browser (and under jsdom) without the Tauri plugins existing.

import { toast, toastError, type ToastHandle } from "./toast";

export interface UpdatePrompt {
  /** Ask whether to install. Resolves true to go ahead. */
  confirm(title: string, message: string, ok: string, cancel: string): Promise<boolean>;
}

/** Human-readable bytes for the progress line. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const mb = n / (1024 * 1024);
  return mb < 1 ? `${Math.round(n / 1024)} KB` : `${mb.toFixed(1)} MB`;
}

/** "Downloading… 62% of 13.4 MB", or without the percentage if unknown. */
export function progressLine(downloaded: number, total: number | null): string {
  if (!total) return `Downloading update… ${formatBytes(downloaded)}`;
  const pct = Math.min(100, Math.round((downloaded / total) * 100));
  return `Downloading update… ${pct}% of ${formatBytes(total)}`;
}

/** Trim release notes to something that fits in a dialog. */
export function shortNotes(notes: string | undefined, limit = 400): string {
  if (!notes) return "";
  const text = notes.trim();
  return text.length <= limit ? text : text.slice(0, limit).trimEnd() + "…";
}

let inFlight = false;

/**
 * Check for a newer release and, with the user's agreement, install it.
 *
 * `silent` suppresses the "you're up to date" and error messages — used for the
 * automatic check shortly after launch, where an interruption would be rude.
 */
export async function checkForUpdates(
  prompt: UpdatePrompt,
  { silent = false }: { silent?: boolean } = {},
): Promise<void> {
  // Two checks at once would download the same thing twice.
  if (inFlight) return;
  inFlight = true;
  let checking: ToastHandle | null = null;
  let progress: ToastHandle | null = null;
  try {
    if (!silent) checking = toast("Checking for updates…", { duration: 0 });

    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();

    checking?.dismiss();
    checking = null;

    if (!update) {
      if (!silent) toast("mad is up to date", { kind: "success" });
      return;
    }

    const notes = shortNotes(update.body);
    const ok = await prompt.confirm(
      `mad ${update.version} is available`,
      notes
        ? `${notes}\n\nDownload it and restart now?`
        : `Download it and restart now?`,
      "Update and Restart",
      "Not Now",
    );
    if (!ok) return;

    progress = toast(progressLine(0, null), { duration: 0 });
    let downloaded = 0;
    let total: number | null = null;

    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? null;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        progress?.setText(progressLine(downloaded, total));
      } else if (event.event === "Finished") {
        progress?.setText("Installing update…");
      }
    });

    progress?.setText("Restarting…");
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    checking?.dismiss();
    // A failed download must not leave "Downloading update…" up forever.
    progress?.dismiss();
    // A silent check must stay silent: no network, a rate limit or an
    // unpublished manifest are all normal and none are the user's problem.
    // A failed *download* is different — the user chose it, so tell them.
    if (!silent || progress) toastError("Couldn’t update", e);
  } finally {
    inFlight = false;
  }
}

/** Reset the in-flight guard. Tests only. */
export function resetUpdaterState(): void {
  inFlight = false;
}
