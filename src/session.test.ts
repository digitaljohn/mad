import { describe, expect, it, vi } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  SESSION_KEY,
  clampScale,
  loadSession,
  parseSession,
  saveSession,
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
    });
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

  it("swallows a quota failure — losing the session is not worth an error", () => {
    const full = {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => saveSession(full, parseSession({}))).not.toThrow();
  });

  it("writes under the documented key", () => {
    const store = memoryStore();
    saveSession(store, parseSession({ root: "/w" }));
    expect(store.map.has(SESSION_KEY)).toBe(true);
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

  it("keeps tabs outside the workspace on trust, since the index misses them", () => {
    expect(usableTabs(["/elsewhere/notes.md"], "/w", known)).toEqual([
      "/elsewhere/notes.md",
    ]);
  });

  it("does not treat a sibling directory as inside the workspace", () => {
    // "/workspace-old/x.md" starts with "/w" but is not under "/w".
    expect(usableTabs(["/workspace-old/x.md"], "/w", known)).toEqual([
      "/workspace-old/x.md",
    ]);
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
