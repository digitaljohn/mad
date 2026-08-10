import { describe, expect, it, vi } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  POSITIONS_CAP,
  RECENT_CAP,
  SESSION_KEY,
  capPositions,
  clampScale,
  clearSession,
  loadSession,
  parseSession,
  pushRecent,
  saveSession,
  sessionKey,
  usableTabs,
  type Session,
} from "./session";

const memoryStore = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
};

describe("clampScale", () => {
  it("keeps sensible values and rounds to whole percents", () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(1.234)).toBe(1.23);
  });

  it("clamps beyond the legible range", () => {
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(0.01)).toBe(MIN_SCALE);
  });

  it("falls back to 1 for anything that isn't a finite number", () => {
    for (const bad of [NaN, Infinity, -Infinity, "1.5", null, undefined, {}]) {
      expect(clampScale(bad)).toBe(1);
    }
  });
});

describe("parseSession", () => {
  it("accepts a well-formed session unchanged", () => {
    const input: Session = {
      root: "/w",
      tabs: ["/w/a.md"],
      active: "/w/a.md",
      expanded: ["/w/docs"],
      sidebarHidden: true,
      scale: 1.2,
      sidebarWidth: "300px",
      recent: ["/w/a.md"],
      positions: { "/w/a.md": { scroll: 120, sel: 44 } },
      draft: "# not yet saved",
      outlineHidden: false,
    };
    expect(parseSession(input)).toEqual(input);
  });

  it("defaults every field when given nothing", () => {
    expect(parseSession({})).toEqual({
      root: null,
      tabs: [],
      active: null,
      expanded: [],
      sidebarHidden: false,
      scale: 1,
      sidebarWidth: null,
      recent: [],
      positions: {},
      draft: null,
      outlineHidden: true,
    });
  });

  it("validates positions field by field — a bad entry drops, not the map", () => {
    const s = parseSession({
      positions: {
        "/w/a.md": { scroll: 10, sel: 5 },
        "/w/b.md": { scroll: "high", sel: 5 },
        "/w/c.md": { scroll: Infinity, sel: 0 },
        "/w/d.md": null,
        "/w/e.md": { scroll: 0 },
      },
    });
    expect(s.positions).toEqual({ "/w/a.md": { scroll: 10, sel: 5 } });
  });

  it("treats a non-object positions blob as empty", () => {
    for (const bad of [null, 7, "x", ["/w/a.md"]]) {
      expect(parseSession({ positions: bad }).positions).toEqual({});
    }
  });

  it("keeps only string entries of recent, capped", () => {
    const s = parseSession({ recent: ["/w/a.md", 9, "/w/b.md"] });
    expect(s.recent).toEqual(["/w/a.md", "/w/b.md"]);
    const many = Array.from({ length: 99 }, (_, i) => `/w/${i}.md`);
    expect(parseSession({ recent: many }).recent).toHaveLength(RECENT_CAP);
  });

  it("stores a draft only when there is text to come back to", () => {
    expect(parseSession({ draft: "# hi" }).draft).toBe("# hi");
    for (const bad of ["", 7, null, {}]) {
      expect(parseSession({ draft: bad }).draft).toBe(null);
    }
  });

  it("keeps the outline hidden unless it was explicitly shown", () => {
    // The panel is opt-in: only a stored `false` (the user opened it) sticks.
    expect(parseSession({ outlineHidden: false }).outlineHidden).toBe(false);
    for (const bad of [true, "no", 0, undefined]) {
      expect(parseSession({ outlineHidden: bad }).outlineHidden).toBe(true);
    }
  });

  it("survives a stored blob of entirely the wrong shape", () => {
    // localStorage is user-editable and outlives upgrades, so this has to be
    // total rather than throwing during startup.
    for (const junk of [null, 42, "string", [], true]) {
      expect(() => parseSession(junk)).not.toThrow();
      expect(parseSession(junk).tabs).toEqual([]);
    }
  });

  it("discards non-string entries inside the arrays", () => {
    const s = parseSession({ tabs: ["/w/a.md", 7, null, "/w/b.md"], expanded: [1] });
    expect(s.tabs).toEqual(["/w/a.md", "/w/b.md"]);
    expect(s.expanded).toEqual([]);
  });

  it("only accepts a pixel width, so a hostile value can't reach the style", () => {
    expect(parseSession({ sidebarWidth: "300px" }).sidebarWidth).toBe("300px");
    expect(parseSession({ sidebarWidth: "300.5px" }).sidebarWidth).toBe("300.5px");
    for (const bad of ["9999em", "calc(100% - 1px)", "red; position:fixed", "300", 300]) {
      expect(parseSession({ sidebarWidth: bad }).sidebarWidth).toBe(null);
    }
  });

  it("treats sidebarHidden as strictly boolean", () => {
    expect(parseSession({ sidebarHidden: "yes" }).sidebarHidden).toBe(false);
    expect(parseSession({ sidebarHidden: 1 }).sidebarHidden).toBe(false);
    expect(parseSession({ sidebarHidden: true }).sidebarHidden).toBe(true);
  });
});

describe("loadSession", () => {
  it("reads and validates what was stored", () => {
    const store = memoryStore({
      [SESSION_KEY]: JSON.stringify({ root: "/w", tabs: ["/w/a.md"] }),
    });
    const s = loadSession(store);
    expect(s.root).toBe("/w");
    expect(s.tabs).toEqual(["/w/a.md"]);
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadSession(memoryStore()).root).toBe(null);
  });

  it("returns defaults for unparseable JSON rather than throwing", () => {
    const store = memoryStore({ [SESSION_KEY]: "{not json" });
    expect(() => loadSession(store)).not.toThrow();
    expect(loadSession(store).tabs).toEqual([]);
  });

  it("survives a storage accessor that throws, as in private mode", () => {
    const hostile = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(() => loadSession(hostile)).not.toThrow();
    expect(loadSession(hostile).scale).toBe(1);
  });
});

describe("saveSession", () => {
  it("round-trips through a store", () => {
    const store = memoryStore();
    const session = parseSession({ root: "/w", tabs: ["/w/a.md"], scale: 1.1 });
    saveSession(store, session);
    expect(loadSession(store)).toEqual(session);
  });

  it("reports a quota failure instead of throwing — the quit path warns on it", () => {
    const full = {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(saveSession(full, parseSession({}))).toBe(false);
  });

  it("reports success when the write lands", () => {
    expect(saveSession(memoryStore(), parseSession({}))).toBe(true);
  });

  it("writes under the documented key", () => {
    const store = memoryStore();
    saveSession(store, parseSession({ root: "/w" }));
    expect(store.map.has(SESSION_KEY)).toBe(true);
  });
});

describe("pushRecent", () => {
  it("puts the newest first and deduplicates", () => {
    expect(pushRecent(["/a", "/b"], "/c")).toEqual(["/c", "/a", "/b"]);
    expect(pushRecent(["/a", "/b"], "/b")).toEqual(["/b", "/a"]);
  });

  it("caps the list", () => {
    const list = Array.from({ length: RECENT_CAP }, (_, i) => `/f${i}`);
    const next = pushRecent(list, "/new");
    expect(next).toHaveLength(RECENT_CAP);
    expect(next[0]).toBe("/new");
    expect(next).not.toContain(`/f${RECENT_CAP - 1}`);
  });

  it("does not mutate its input", () => {
    const list = ["/a"];
    pushRecent(list, "/b");
    expect(list).toEqual(["/a"]);
  });
});

describe("capPositions", () => {
  it("returns the same object under the cap", () => {
    const p = { "/a": { scroll: 1, sel: 2 } };
    expect(capPositions(p)).toBe(p);
  });

  it("keeps the newest entries when over the cap", () => {
    const p: Record<string, { scroll: number; sel: number }> = {};
    for (let i = 0; i < POSITIONS_CAP + 5; i++) p[`/f${i}`] = { scroll: i, sel: 0 };
    const capped = capPositions(p);
    expect(Object.keys(capped)).toHaveLength(POSITIONS_CAP);
    // Insertion order is the age order here — the oldest five fall off.
    expect(capped["/f0"]).toBeUndefined();
    expect(capped[`/f${POSITIONS_CAP + 4}`]).toEqual({
      scroll: POSITIONS_CAP + 4,
      sel: 0,
    });
  });
});

describe("usableTabs", () => {
  const known = new Set(["/w/a.md", "/w/docs/b.md"]);

  it("keeps in-workspace tabs that still exist", () => {
    expect(usableTabs(["/w/a.md", "/w/docs/b.md"], "/w", known)).toEqual([
      "/w/a.md",
      "/w/docs/b.md",
    ]);
  });

  it("drops in-workspace tabs whose file has gone", () => {
    expect(usableTabs(["/w/a.md", "/w/deleted.md"], "/w", known)).toEqual(["/w/a.md"]);
  });

  it("drops tabs outside the workspace — their dialog grant died with the session", () => {
    // Restoring one would open a document the scoped backend refuses to save.
    expect(usableTabs(["/elsewhere/notes.md"], "/w", known)).toEqual([]);
  });

  it("does not treat a sibling directory as inside the workspace", () => {
    // "/workspace-old/x.md" starts with "/w" but is not under "/w".
    expect(usableTabs(["/workspace-old/x.md"], "/w", known)).toEqual([]);
  });

  it("returns nothing for an empty list", () => {
    expect(usableTabs([], "/w", known)).toEqual([]);
  });
});

describe("real localStorage", () => {
  it("works against the browser implementation, not just the fake", () => {
    const session = parseSession({ root: "/w", tabs: ["/w/a.md"] });
    saveSession(localStorage, session);
    expect(loadSession(localStorage)).toEqual(session);
  });

  it("does not leak between tests", () => {
    // The setup file clears storage; prove it, since every other test relies
    // on that isolation.
    expect(localStorage.getItem(SESSION_KEY)).toBe(null);
  });

  it("tolerates JSON.stringify blowing up on a circular session", () => {
    const spy = vi.spyOn(JSON, "stringify").mockImplementation(() => {
      throw new TypeError("circular");
    });
    expect(() => saveSession(localStorage, parseSession({}))).not.toThrow();
    spy.mockRestore();
  });
});

describe("per-window sessions", () => {
  it("keeps the bare key for the first window, so old sessions still restore", () => {
    expect(sessionKey("main")).toBe(SESSION_KEY);
  });

  it("gives every other window its own key", () => {
    expect(sessionKey("mad-2")).toBe(`${SESSION_KEY}:mad-2`);
    expect(sessionKey("mad-3")).not.toBe(sessionKey("mad-2"));
  });

  it("does not let two windows overwrite each other's tabs", () => {
    // The bug this prevents: one shared key, last writer wins, and window A's
    // tab list vanishes every time window B autosaves its session.
    const a = parseSession({ root: "/a", tabs: ["/a/one.md"] });
    const b = parseSession({ root: "/b", tabs: ["/b/two.md"] });
    saveSession(localStorage, a, sessionKey("main"));
    saveSession(localStorage, b, sessionKey("mad-2"));

    expect(loadSession(localStorage, sessionKey("main"))).toEqual(a);
    expect(loadSession(localStorage, sessionKey("mad-2"))).toEqual(b);
  });

  it("forgets a closed window's session instead of accumulating dead keys", () => {
    const key = sessionKey("mad-2");
    saveSession(localStorage, parseSession({ root: "/b" }), key);
    clearSession(localStorage, key);
    expect(localStorage.getItem(key)).toBe(null);
    // An absent session is a fresh window, not a crash.
    expect(loadSession(localStorage, key)).toEqual(parseSession({}));
  });

  it("survives storage refusing to remove a key", () => {
    const spy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => clearSession(localStorage, sessionKey("mad-2"))).not.toThrow();
    spy.mockRestore();
  });
});
