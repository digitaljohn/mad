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
}

export const SESSION_KEY = "mad:session";

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
  };
}

/** Read the stored session, tolerating absent or corrupt data. */
export function loadSession(store: Pick<Storage, "getItem">): Session {
  try {
    const raw = store.getItem(SESSION_KEY);
    return parseSession(raw ? JSON.parse(raw) : {});
  } catch {
    return parseSession({});
  }
}

/** Persist a session. Quota or private-mode failures are not worth surfacing. */
export function saveSession(
  store: Pick<Storage, "setItem">,
  session: Session,
): void {
  try {
    store.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* the session is a nicety, not a requirement */
  }
}

/**
 * Which remembered tabs are still worth reopening. Paths inside the workspace
 * must still exist (checked against the file index); paths outside it are kept
 * on trust, since the index doesn't cover them.
 */
export function usableTabs(
  tabs: string[],
  root: string,
  known: ReadonlySet<string>,
): string[] {
  return tabs.filter((p) => (p.startsWith(root + "/") ? known.has(p) : true));
}
