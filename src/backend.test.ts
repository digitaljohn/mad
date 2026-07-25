import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONFLICT, createBackend, isConflict, isTauri, type Backend } from "./backend";

// The browser mock is what `npm run dev` runs against and what the UI tests
// lean on, so its behaviour has to match the Rust commands it stands in for.
let be: Backend;
beforeEach(async () => {
  be = await createBackend();
});

describe("environment detection", () => {
  it("does not think jsdom is Tauri", () => {
    expect(isTauri).toBe(false);
  });

  it("hands back the mock outside the app", async () => {
    expect(await be.pickFolder()).toBe("/demo");
  });
});

describe("isConflict", () => {
  it("recognises the marker however it is wrapped", () => {
    expect(isConflict(CONFLICT)).toBe(true);
    expect(isConflict(new Error(CONFLICT))).toBe(true);
    expect(isConflict(`invoke failed: ${CONFLICT}`)).toBe(true);
  });

  it("does not fire on ordinary failures", () => {
    expect(isConflict(new Error("permission denied"))).toBe(false);
    expect(isConflict(null)).toBe(false);
  });
});

describe("listDir", () => {
  it("returns one level, directories before files", async () => {
    const names = (await be.listDir("/demo")).map((e) => e.name);
    expect(names[0]).toBe("journal");
    expect(names).toContain("welcome.md");
  });

  it("marks directories", async () => {
    const journal = (await be.listDir("/demo")).find((e) => e.name === "journal");
    expect(journal?.is_dir).toBe(true);
  });

  it("does not leak grandchildren into a parent listing", async () => {
    const paths = (await be.listDir("/demo")).map((e) => e.path);
    expect(paths).not.toContain("/demo/journal/ideas.md");
  });

  it("is empty for an unknown directory", async () => {
    expect(await be.listDir("/nope")).toEqual([]);
  });
});

describe("read and write", () => {
  it("round-trips content and reports a new stamp", async () => {
    const before = await be.readFile("/demo/README.md");
    const stamp = await be.writeFile("/demo/README.md", "changed\n", before.stamp);
    expect(stamp).not.toBe(before.stamp);
    const after = await be.readFile("/demo/README.md");
    expect(after.content).toBe("changed\n");
    expect(after.stamp).toBe(stamp);
  });

  it("rejects reading a file that isn't there", async () => {
    await expect(be.readFile("/demo/ghost.md")).rejects.toThrow(/not found/);
  });

  it("refuses a write whose expected stamp is stale", async () => {
    const { stamp } = await be.readFile("/demo/README.md");
    await be.writeFile("/demo/README.md", "someone else\n", null);
    await expect(
      be.writeFile("/demo/README.md", "mine\n", stamp),
    ).rejects.toThrow(CONFLICT);
  });

  it("allows a forced write, which is the keep-mine path", async () => {
    const { stamp } = await be.readFile("/demo/README.md");
    await be.writeFile("/demo/README.md", "other\n", null);
    await expect(be.writeFile("/demo/README.md", "mine\n", null)).resolves.toBeTypeOf(
      "string",
    );
    expect((await be.readFile("/demo/README.md")).content).toBe("mine\n");
    expect(stamp).toBeTypeOf("string");
  });

  it("reports the stamp alone without reading the body", async () => {
    const { stamp } = await be.readFile("/demo/README.md");
    expect(await be.fileStamp("/demo/README.md")).toBe(stamp);
  });
});

describe("createFile", () => {
  it("creates the requested name when free", async () => {
    expect(await be.createFile("/demo", "New.md")).toBe("/demo/New.md");
  });

  it("dedupes rather than clobbering", async () => {
    const a = await be.createFile("/demo", "Dup.md");
    const b = await be.createFile("/demo", "Dup.md");
    expect(a).toBe("/demo/Dup.md");
    expect(b).toBe("/demo/Dup 2.md");
  });

  it("keeps the extension when deduping", async () => {
    await be.createFile("/demo", "x.md");
    expect(await be.createFile("/demo", "x.md")).toMatch(/x 2\.md$/);
  });
});

describe("saveImage", () => {
  it("returns the file name and makes it visible in the folder", async () => {
    const name = await be.saveImage("/demo", "shot.png", "");
    expect(name).toBe("shot.png");
    const names = (await be.listDir("/demo")).map((e) => e.name);
    expect(names).toContain("shot.png");
  });

  it("dedupes a repeated paste", async () => {
    await be.saveImage("/demo", "shot.png", "");
    expect(await be.saveImage("/demo", "shot.png", "")).toBe("shot 2.png");
  });
});

describe("rename and move", () => {
  it("renames a file", async () => {
    await be.renamePath("/demo/README.md", "/demo/GUIDE.md");
    await expect(be.readFile("/demo/GUIDE.md")).resolves.toBeTruthy();
    await expect(be.readFile("/demo/README.md")).rejects.toThrow();
  });

  it("dedupes extensionless names without inventing an extension", async () => {
    // "LICENSE 2", not "LICENSE 2.undefined" — the stem/ext split must cope.
    expect(await be.createFile("/demo", "LICENSE")).toBe("/demo/LICENSE");
    expect(await be.createFile("/demo", "LICENSE")).toBe("/demo/LICENSE 2");
    expect(await be.saveImage("/demo", "img", "")).toBe("img");
    expect(await be.saveImage("/demo", "img", "")).toBe("img 2");
  });

  it("trashes a folder with nested subfolders in one go", async () => {
    await be.createFolder("/demo/journal", "deep");
    await be.trashPath("/demo/journal");
    const names = (await be.listDir("/demo")).map((e) => e.name);
    expect(names).not.toContain("journal");
    expect(await be.listDir("/demo/journal/deep")).toEqual([]);
  });

  it("renames a folder together with the subfolders inside it", async () => {
    await be.createFolder("/demo/journal", "deep");
    await be.createFile("/demo/journal/deep", "x.md");
    await be.renamePath("/demo/journal", "/demo/log");
    expect((await be.readFile("/demo/log/deep/x.md")).content).toBe("");
    const names = (await be.listDir("/demo/log")).map((e) => e.name);
    expect(names).toContain("deep");
  });

  it("duplicates a folder as an empty sibling, the way the mock models dirs", async () => {
    const copy = await be.duplicatePath("/demo/journal");
    expect(copy).toBe("/demo/journal copy");
    const names = (await be.listDir("/demo")).map((e) => e.name);
    expect(names).toContain("journal copy");
  });

  it("refuses to rename over an existing entry", async () => {
    await expect(
      be.renamePath("/demo/README.md", "/demo/welcome.md"),
    ).rejects.toThrow(/exists/);
  });

  it("moves a whole directory subtree", async () => {
    await be.createFolder("/demo", "archive");
    await be.moveInto("/demo/journal", "/demo/archive");
    const names = (await be.listDir("/demo/archive/journal")).map((e) => e.name);
    expect(names).toContain("ideas.md");
  });

  it("is a no-op when the destination is already the parent", async () => {
    expect(await be.moveInto("/demo/README.md", "/demo")).toBe("/demo/README.md");
  });

  it("refuses to move onto an existing name", async () => {
    await be.createFolder("/demo", "dest");
    await be.createFile("/demo/dest", "README.md");
    await expect(be.moveInto("/demo/README.md", "/demo/dest")).rejects.toThrow(
      /exists/,
    );
  });
});

describe("createFolder and duplicate", () => {
  it("creates and dedupes folders", async () => {
    expect(await be.createFolder("/demo", "New Folder")).toBe("/demo/New Folder");
    expect(await be.createFolder("/demo", "New Folder")).toBe("/demo/New Folder 2");
  });

  it("copies a file beside itself", async () => {
    const copy = await be.duplicatePath("/demo/README.md");
    expect(copy).toBe("/demo/README copy.md");
    expect((await be.readFile(copy)).content).toBe(
      (await be.readFile("/demo/README.md")).content,
    );
  });

  it("dedupes a second copy", async () => {
    await be.duplicatePath("/demo/README.md");
    expect(await be.duplicatePath("/demo/README.md")).toBe("/demo/README copy 2.md");
  });
});

describe("trashPath", () => {
  it("removes a file", async () => {
    await be.trashPath("/demo/README.md");
    await expect(be.readFile("/demo/README.md")).rejects.toThrow();
  });

  it("removes a directory and everything under it", async () => {
    await be.trashPath("/demo/journal");
    await expect(be.readFile("/demo/journal/ideas.md")).rejects.toThrow();
    expect((await be.listDir("/demo")).map((e) => e.name)).not.toContain("journal");
  });
});

describe("listAll", () => {
  it("returns every file with a workspace-relative path", async () => {
    const rels = (await be.listAll("/demo")).map((f) => f.rel);
    expect(rels).toContain("welcome.md");
    expect(rels).toContain("journal/ideas.md");
  });

  it("orders case-insensitively, matching the Rust walker", async () => {
    const rels = (await be.listAll("/demo")).map((f) => f.rel);
    const expected = [...rels].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
    expect(rels).toEqual(expected);
    // Concretely: "demo image.png" sorts before "README.md", which a
    // code-unit sort would get backwards.
    expect(rels.indexOf("demo image.png")).toBeLessThan(rels.indexOf("README.md"));
  });
});

describe("searchFiles", () => {
  const opts = { regex: false, caseSensitive: false, wholeWord: false };

  it("finds a literal match with a line number", async () => {
    const { hits } = await be.searchFiles("/demo", "Ideas", opts);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].line).toBeGreaterThan(0);
  });

  it("returns nothing for a blank query", async () => {
    expect((await be.searchFiles("/demo", "   ", opts)).hits).toEqual([]);
  });

  it("honours case sensitivity", async () => {
    const insensitive = await be.searchFiles("/demo", "ideas", opts);
    const sensitive = await be.searchFiles("/demo", "ideas", {
      ...opts,
      caseSensitive: true,
    });
    expect(insensitive.hits.length).toBeGreaterThan(sensitive.hits.length);
  });

  it("honours whole-word matching", async () => {
    const partial = await be.searchFiles("/demo", "them", opts);
    const whole = await be.searchFiles("/demo", "them", { ...opts, wholeWord: true });
    expect(whole.hits.length).toBeLessThanOrEqual(partial.hits.length);
  });

  it("treats the query literally unless regex is on", async () => {
    const literal = await be.searchFiles("/demo", "m.rkdown", opts);
    expect(literal.hits).toEqual([]);
    const regex = await be.searchFiles("/demo", "m.rkdown", { ...opts, regex: true });
    expect(regex.hits.length).toBeGreaterThan(0);
  });

  it("reports character offsets that index the returned text", async () => {
    const { hits } = await be.searchFiles("/demo", "tiny", opts);
    for (const h of hits) {
      expect([...h.text].slice(h.start, h.end).join("").toLowerCase()).toBe("tiny");
    }
  });

  it("only searches markdown", async () => {
    const { hits } = await be.searchFiles("/demo", "demo", opts);
    expect(hits.every((h) => h.rel.endsWith(".md"))).toBe(true);
  });
});

describe("git helpers in the mock", () => {
  it("reports a plausible status so decorations can be styled offline", async () => {
    const info = await be.gitStatus("/demo");
    expect(info?.entries.some((e) => e.path === "/demo/README.md")).toBe(true);
  });

  it("only reports files it actually has", async () => {
    await be.trashPath("/demo/README.md");
    const info = await be.gitStatus("/demo");
    expect(info?.entries.some((e) => e.path === "/demo/README.md")).toBe(false);
  });

  it("returns a diff for a changed file and nothing for others", async () => {
    expect(await be.gitDiff("/demo/README.md")).toContain("@@");
    expect(await be.gitDiff("/demo/welcome.md")).toBe(null);
  });

  it("restores content on discard", async () => {
    await be.writeFile("/demo/README.md", "wrecked\n", null);
    expect(await be.gitDiscard("/demo/README.md")).toBe("restored");
    expect((await be.readFile("/demo/README.md")).content).toContain("Just a demo file");
  });

  it("predicts the discard outcome the way the Rust side would", async () => {
    // README is "committed" in the mock's world; everything else is not.
    expect(await be.gitDiscardKind("/demo/README.md")).toBe("restore");
    expect(await be.gitDiscardKind("/demo/journal/ideas.md")).toBe("trash");
  });
});

describe("dialogs and shell in the mock", () => {
  it("appends .md when the save dialog is given a bare name", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("notes");
    expect(await be.saveDialog("Untitled.md", "/demo")).toBe("/demo/notes.md");
  });

  it("keeps an extension the user already supplied", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("notes.markdown");
    expect(await be.saveDialog("Untitled.md", "/demo")).toBe("/demo/notes.markdown");
  });

  it("returns null when the save dialog is cancelled", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    expect(await be.saveDialog("Untitled.md", "/demo")).toBe(null);
  });

  it("falls back to the demo root when no directory is offered", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("notes");
    expect(await be.saveDialog("Untitled.md", null)).toBe("/demo/notes.md");
  });

  it("passes the export name through", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("out.html");
    expect(await be.exportDialog("out.html", "/demo", "html")).toBe("/demo/out.html");
  });

  it("returns null when the export dialog is cancelled", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    expect(await be.exportDialog("out.html", null, "html")).toBe(null);
  });

  it("export falls back to the demo root when no directory is offered", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("out.html");
    expect(await be.exportDialog("out.html", null, "html")).toBe("/demo/out.html");
  });

  it("relays confirmations", async () => {
    const spy = vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(await be.confirm("t", "m")).toBe(true);
    spy.mockReturnValue(false);
    expect(await be.confirm("t", "m")).toBe(false);
  });

  it("relays a two-choice confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(await be.confirmChoice("t", "m", "Yes", "No")).toBe(true);
  });

  it("has no-op implementations for the native-only calls", async () => {
    await expect(be.revealPath("/demo")).resolves.toBeUndefined();
    await expect(be.openPath("/demo")).resolves.toBeUndefined();
    await expect(be.setMenuState(true, true, true)).resolves.toBeUndefined();
    await expect(be.watchFolder("/demo")).resolves.toBeUndefined();
  });

  it("returns a displayable URL for images and the path otherwise", async () => {
    expect(await be.toDisplayUrl("/demo/pic.png")).toMatch(/^data:image\//);
    expect(await be.toDisplayUrl("/demo/README.md")).toBe("/demo/README.md");
  });
});
