// Lightweight, non-blocking notifications. Used for anything the user should
// notice but never has to answer — failures we already recovered from, results
// of background work, undoable actions. Real decisions still use native dialogs.

export type ToastKind = "info" | "error" | "success";

/** Handle to a live toast, so long-running work can report progress in place. */
export interface ToastHandle {
  dismiss(): void;
  /** Replace the message without the toast flickering out and back. */
  setText(text: string): void;
}

interface ToastOptions {
  kind?: ToastKind;
  /** ms before it fades; 0 keeps it until dismissed. */
  duration?: number;
  /** Optional single action button (e.g. "Undo"). */
  action?: { label: string; run: () => void };
}

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  // `isConnected` matters: anything that replaces document.body's contents
  // detaches the host while this module still holds a reference to it, and
  // toasts would then be appended to an orphan node — visible to nobody.
  if (!host || !host.isConnected) {
    host = document.createElement("div");
    host.id = "toasts";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  return host;
}

export function toast(message: string, opts: ToastOptions = {}): ToastHandle {
  const { kind = "info", duration = kind === "error" ? 6000 : 3200, action } = opts;
  const el = document.createElement("div");
  el.className = `toast ${kind}`;

  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = message;
  el.appendChild(text);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let leaving = false;
  const dismiss = () => {
    if (leaving) return; // reachable from the timer AND an action click
    leaving = true;
    clearTimeout(timer);
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 180); // after the exit transition
  };

  if (action) {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      dismiss();
      action.run();
    });
    el.appendChild(btn);
  }

  const close = document.createElement("button");
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss");
  close.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>`;
  close.addEventListener("click", dismiss);
  el.appendChild(close);

  ensureHost().appendChild(el);
  // Trigger the enter transition on the next frame.
  requestAnimationFrame(() => el.classList.add("in"));
  if (duration > 0) timer = setTimeout(dismiss, duration);
  return {
    dismiss,
    setText: (next: string) => {
      text.textContent = next;
    },
  };
}

/** Convenience wrapper: report a caught error without blocking the user. */
export function toastError(prefix: string, e: unknown) {
  const raw = e instanceof Error ? e.message : String(e);
  // Rust errors arrive as plain strings; trim the noisy `os error N` suffix.
  const msg = raw.replace(/\s*\(os error \d+\)\s*$/, "");
  toast(`${prefix}: ${msg}`, { kind: "error" });
}
