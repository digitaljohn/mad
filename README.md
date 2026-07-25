# mad

**A tiny markdown editor that gives your file back the way it found it.**

Built with [Tauri 2](https://v2.tauri.app) and [Milkdown Crepe](https://milkdown.dev),
dressed in Claude's design tokens, and carrying exactly one strong opinion.

![mad, dark](docs/screenshot-dark.png)

## Why does this exist

Every WYSIWYG markdown editor makes the same promise, and most of them quietly
break it. You open a note, click around for a minute, and your `-` bullets have
become `*`, your tight lists have sprouted blank lines, your `---` is now `***`,
and the alt text on your architecture diagram has been replaced with the string
`1.00` for reasons known only to a serializer.

Then you `git diff` and forty lines light up. You changed one word.

mad exists because that is unacceptable in a program whose entire job is holding
text. There is a test that pushes a document through the rich editor and back out
again and asserts the bytes are **identical** — headings, tight lists, ordered
lists, thematic breaks, images with alt text, task lists, blockquotes, tables,
fenced code. It passes.

Everything else in here — the tabs, the palette, the git badges, the mermaid
diagrams — is just the equipment you need in order to actually use the thing.

## Things we fixed that we should not have had to

Three of these were live bugs in the editor library underneath. All three fire
the instant you open a file and save it, which is to say: always.

| The bug | What it did to your file |
| --- | --- |
| The image block stores its zoom level in the markdown `alt` field | `![diagram](x.png)` → `![1.00](x.png)`. Alt text gone. |
| `bullet_list.spread` is kept as the **string** `"false"`, then handed to mdast unchanged — and `"false"` is truthy | every bullet list serialized *loose*, gaining a blank line between items on every save |
| remark-stringify's defaults | `-` → `*`, `---` → `***` |

Patched in [`src/editor.ts`](src/editor.ts) by overriding the node schemas
*after* Crepe registers its own. The duplicate node id wins because Milkdown
assembles its schema with `Object.fromEntries`, and the parser and serializer
both read their runners off the final schema — so exactly one spec survives.
This is documented nowhere. You're welcome.

The fourth one was ours: ProseMirror keeps a trailing empty paragraph, so the
first save of any document used to append a blank line. Now normalized to
exactly one trailing newline, like a well-raised text file.

## It also refuses to lose your work

- Writes go **temp file → fsync → rename**, with the original's permissions
  carried across. A full disk or a hard crash cannot truncate a note.
- Every open file carries an mtime+size stamp. If it changed on disk *and* in the
  editor, mad asks which version wins rather than picking for you.
- The workspace is watched. Edit a note in another app and mad reloads it —
  unless you have unsaved changes, in which case see above.
- New files are **drafts**. Nothing touches the disk until you choose a location.
- Delete means the **system Trash**, not `unlink(2)`.
- Tabs, expanded folders, sidebar width, zoom and window geometry all come back
  on next launch.

## What's in the box

**Editing** — WYSIWYG markdown with tables, images, code blocks, task lists and
quotes; `/` for a block menu; a selection toolbar. Rich ⇄ raw toggle, or a split
view with a live preview and synced scrolling. Mermaid diagrams render under
` ```mermaid ` fences. Find & replace with case and whole-word, plus full-text
search across every file. A fuzzy command palette. Spell check, text zoom,
light and dark.

**Files** — a folder tree with real keyboard navigation, drag-to-move, rename in
place, duplicate, Reveal in Finder, Copy Path. Paste or drag images straight in
and they're stored next to the `.md` and referenced relatively. Drag an image out
of the tree into the document. Export any note as one self-contained HTML file.

**Git** — if the folder is a repository, changed files get a letter (`M` `A` `U`
`D` `R` `!`) and a tinted name, and folders containing changes get a dot. It
shells out to `git status --porcelain`; there is no libgit2 and no polling. It
refreshes on save, on filesystem events, on `.git` bookkeeping (commit, stage,
checkout) and when the window regains focus — so committing in a terminal shows
up when you switch back.

<details>
<summary>Light mode, because some people work in daylight</summary>

![mad, light](docs/screenshot-light.png)

</details>

## Shortcuts

| | |
| --- | --- |
| `⌘P` / `⌘⇧P` | Go to file / command palette |
| `⌘N` / `⌘⇧N` | New file / new folder |
| `⌘O` | Open folder |
| `⌘S` / `⌘⇧S` | Save / Save As |
| `⌘W` | Close tab |
| `⌘1`…`⌘9`, `⌘⌥←/→` | Switch tabs |
| `⌘F` / `⌘⌥F` / `⌘⇧F` | Find / find & replace / find in files |
| `⌘⇧M` / `⌘⇧V` | Toggle markdown source / split preview |
| `⌘\` | Toggle sidebar |
| `⌘=` / `⌘-` / `⌘0` | Zoom in / out / actual size |
| `⌘B` `⌘I` `⌘E` | Bold / italic / inline code |
| `F2`, `⌫` | Rename / delete in the tree |

## Running it

```bash
npm install
npm run tauri dev
```

`npm run dev` on its own serves the entire UI in a plain browser against an
in-memory demo workspace — no Rust, no Tauri. Most of the styling was done that
way, and it's how the screenshots above were taken.

```bash
npm test              # tsc + 23 Rust tests
npm run tauri build
```

## How it's put together

```
src/
  main.ts      app wiring: tabs, session, menus, search, git, shortcuts
  editor.ts    Crepe wrapper: save chain, conflict resolution, find,
               split view, the markdown round-trip fixes, HTML export
  tree.ts      folder browser: keyboard nav, drag & drop, git decorations
  palette.ts   fuzzy command palette
  toast.ts     notifications that don't block you
  backend.ts   the Tauri IPC surface, plus an in-memory browser mock
  styles.css   Claude theme tokens, dark and light
src-tauri/
  src/lib.rs   every command, the native menu, the filesystem watcher
```

The Rust side owns the filesystem and the native menu; there is no `fs` plugin
and no asset protocol, so the app ships with a real CSP and no wildcard scopes.
Images cross the IPC bridge as base64 data URLs. The tests live at the bottom of
`lib.rs` and cover the things that would ruin your day: atomic writes, save
conflicts, path traversal in image names, porcelain parsing, and a real
`git init`'d repository.

## The name

Short for **ma**rk**d**own. Also an accurate description of how one feels after
reading a markdown serializer's source code. Both readings are supported.

---

<sub>Written with [Claude Code](https://claude.com/claude-code), which also found
the three upstream bugs by refusing to trust that a round-trip was lossless.</sub>
