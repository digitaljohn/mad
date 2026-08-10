// What the app remembers between launches, and the rules for trusting it back.
//
// localStorage is user-editable, survives upgrades, and can contain anything a
// previous version wrote — so parsing is total: every field is validated and a
// bad one falls back to its default rather than breaking startup.

export interface Session {
  root: string | null;
  tabs: string[];
  active: string | null;
  expanded: string[];
  sidebarHidden: boolean;
  scale: number;
  sidebarWidth: string | null;
  /** Recently active files, most recent first — feeds Quick Open's ordering. */
  recent: string[];
  /** Last cursor offset and scroll position per open file. */
  positions: Record<string, ViewPosition>;
  /** The unsaved draft's text, so a quit or crash can't destroy it. */
  draft: string | null;
  outlineHidden: boolean;
}

export interface ViewPosition {
  /** Scroll offset of the active editing surface, in pixels. */
  scroll: number;
  /** Caret position — a ProseMirror position or a textarea offset. */
  sel: number;
}

/** How many recently-used files are worth remembering. */
export const RECENT_CAP = 30;
/** How many per-file positions are worth carrying across launches. */
export const POSITIONS_CAP = 100;

/** Move `path` to the front of a most-recent-first list, deduplicated. */
export function pushRecent(
  list: readonly string[],
  path: string,
  cap: number = RECENT_CAP,
): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, cap);
}

/** Keep the newest `cap` entries of a positions map (insertion order). */
export function capPositions(
  positions: Record<string, ViewPosition>,
  cap: number = POSITIONS_CAP,
): Record<string, ViewPosition> {
  const entries = Object.entries(positions);
  if (entries.length <= cap) return positions;
  return Object.fromEntries(entries.slice(entries.length - cap));
}

const isViewPosition = (v: unknown): v is ViewPosition =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as ViewPosition).scroll === "number" &&
  Number.isFinite((v as ViewPosition).scroll) &&
  typeof (v as ViewPosition).sel === "number" &&
  Number.isFinite((v as ViewPosition).sel);

const positions = (v: unknown): Record<string, ViewPosition> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  const out: Record<string, ViewPosition> = {};
  for (const [k, val] of Object.entries(v)) {
    if (isViewPosition(val)) out[k] = { scroll: val.scroll, sel: val.sel };
  }
  return capPositions(out);
};

export const SESSION_KEY = "mad:session";

/**
 * Where one window's session lives. localStorage is shared by every window in
 * the app, so each keeps its own key — otherwise two windows would overwrite
 * each other's tab list on every debounce.
 *
 * The first window keeps the bare key so sessions written before mad had
 * multiple windows still restore.
 */
export function sessionKey(label: string): string {
  return label === "main" ? SESSION_KEY : `${SESSION_KEY}:${label}`;
}

/** Document text scale limits, shared by the zoom commands and the restorer. */
export const MIN_SCALE = 0.7;
export const MAX_SCALE = 2;

export function clampScale(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(v * 100) / 100));
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Validate an unknown blob into a usable session. Never throws. */
export function parseSession(raw: unknown): Session {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  return {
    root: typeof o.root === "string" ? o.root : null,
    tabs: strings(o.tabs),
    active: typeof o.active === "string" ? o.active : null,
    expanded: strings(o.expanded),
    sidebarHidden: o.sidebarHidden === true,
    scale: clampScale(o.scale),
    sidebarWidth:
      typeof o.sidebarWidth === "string" && /^\d+(\.\d+)?px$/.test(o.sidebarWidth)
        ? o.sidebarWidth
        : null,
    recent: strings(o.recent).slice(0, RECENT_CAP),
    positions: positions(o.positions),
    draft: typeof o.draft === "string" && o.draft.length > 0 ? o.draft : null,
    outlineHidden: o.outlineHidden !== false,
  };
}

/** Read a window's stored session, tolerating absent or corrupt data. */
export function loadSession(
  store: Pick<Storage, "getItem">,
  key: string = SESSION_KEY,
): Session {
  try {
    const raw = store.getItem(key);
    return parseSession(raw ? JSON.parse(raw) : {});
  } catch {
    return parseSession({});
  }
}

/** Persist a session. Quota or private-mode failures are not worth an error,
    but they ARE worth reporting: the session now carries the unsaved draft,
    and a caller about to quit must warn instead of silently losing it. */
export function saveSession(
  store: Pick<Storage, "setItem">,
  session: Session,
  key: string = SESSION_KEY,
): boolean {
  try {
    store.setItem(key, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

/** Forget a window's session — called when that window closes for good. */
export function clearSession(
  store: Pick<Storage, "removeItem">,
  key: string,
): void {
  try {
    store.removeItem(key);
  } catch {
    /* nothing to do if storage is unavailable */
  }
}

/**
 * Which remembered tabs are still worth reopening: paths inside the workspace
 * that still exist (checked against the file index). Out-of-root tabs are
 * dropped — they were reachable through a dialog grant that does not survive a
 * restart, so restoring them would open documents that can never save again.
 */
export function usableTabs(
  tabs: string[],
  root: string,
  known: ReadonlySet<string>,
): string[] {
  return tabs.filter((p) => p.startsWith(root + "/") && known.has(p));
}
