# Changelog

Notable changes per release. mad follows [semver](https://semver.org) as far as
a 0.x app can: expect minor-version bumps for features, patch bumps for fixes.

## 0.2.3 — 2026-07-28

Multiple windows, made genuinely standalone. 0.2.0 shipped the feature; an
adversarial audit of all 26 cross-window paths found five real couplings
between windows that are supposed to be independent — two of which could
destroy unsaved work. All five are fixed here.

### Fixed

- **A menu command could fire in every window at once.** Open Folder in one
  window opened that folder in both. Commands are routed to the focused
  window, but when no window reports focus the fallback was to let every
  window decide — which for standalone windows is precisely wrong. A command
  now resolves to exactly one window or none: the last-focused window if it
  is still open, else whichever reports focus now, else the only window,
  else nothing. `Close Window` had the same flaw inverted — with nothing
  focused, ⇧⌘W closed nothing at all.
- **An abandoned quit could quit the app much later, taking a draft with
  it.** ⌘Q, one window agrees, another declines because it has unsaved
  changes. The agreement was remembered *forever*; simply closing the first
  window later made the app conclude every remaining window had agreed, and
  exit — discarding the draft that had just refused. A tally now only counts
  while a quit is genuinely being asked about, and declining clears it.
- **A window could be wedged permanently by a cancelled quit.** After
  another window cancelled, a window that had already agreed could no longer
  be closed and never answered another ⌘Q, blocking quit for the whole app.
  Its re-entrancy guard is now always released.
- **A new window could open a folder you never picked.** Window names are
  reused and the session store is shared, so ⇧⌘N could restore whatever a
  long-gone window had left behind — verified in a live app, where a stale
  entry still pointed at a workspace closed hours earlier. A new window now
  starts empty and clears that entry before reading it.

### Changed

- **The right-click menu reads properly.** Its labels used the colour this
  app reserves for secondary text, which on a popover — where every row is a
  primary action — looked half-disabled. They are full strength now, rows
  are 26px rather than 28, and disabled items use the muted colour directly
  instead of 40% opacity over already-muted text. Rename and Delete show
  their keyboard equivalents (F2 and ⌘⌫); ⌘⌫ had no other home in the UI
  since 0.2.0 moved tree deletion off a bare Backspace.
- **Releases say what changed.** Until now the GitHub release body was
  install instructions only, and the update prompt inside the app showed a
  bare link. Both are now generated from this file, and a tag with no
  changelog entry fails the release in ten seconds instead of publishing
  something silent.

### Known issue

- Installing an update relaunches the app without asking other windows to
  save first, so **unsaved edits in windows other than the one that started
  the update are lost.** Save before updating. The fix belongs with the
  quit-flow consent it should be sharing, and is next.

## 0.2.2 — 2026-07-25

Nothing changes in the app. This is a build-toolchain release, published
because the thing users download is now produced by a different bundler and
that is worth proving in the open rather than assuming.

### Changed

- Built with TypeScript 7, Vite 8 and Vitest 4. The app bundle is now built
  by Rolldown rather than Rollup — same code, different machinery.
- TypeScript 7 requires a type declaration for side-effect imports, so
  `vite/client` is now in `tsconfig`; that is what gives
  `import "./styles.css"` a type.
- The coverage floor is 95% across the board. Vitest 4 maps coverage through
  the AST rather than by line, so it counts defensive branches the previous
  provider credited silently — the same code measures slightly lower without
  anything having got worse.

### Fixed

- "Copy Path" claimed success when both the clipboard API *and* its fallback
  were blocked. It now says it failed, which is what the newer coverage
  measurement turned up.

## 0.2.1 — 2026-07-25

Both of 0.2.0's user-facing breakages, found within minutes of release.

### Fixed

- **Extra windows didn't work.** A window opened with File ▸ New Window came
  up with no permissions at all: it couldn't be dragged, couldn't be closed,
  and never received a single menu command. The app's capability was still
  scoped to the first window alone, and `core:default` grants only read-only
  window queries — so dragging and closing now have to be, and are, named
  explicitly. A failed close also says so now instead of presenting as a dead
  button.
- **Links between notes opened a browser window.** `[spec](./spec.md)` sent
  you to your browser rather than to the document. The link handler read the
  DOM-resolved URL, which resolves a relative path against the webview's own
  origin — so a link to the note next door was indistinguishable from a link
  to the open internet. Links now resolve from the href as written: another
  note or image opens in a tab, anything else on disk goes to the OS, real
  URLs still open in your browser, and `#heading` scrolls.

## 0.2.0 — 2026-07-25

### Added

- **Multiple windows.** File ▸ New Window (⇧⌘N) opens another window with its
  own folder, tabs, file watching and session — so two projects can be open
  side by side. The menu bar follows whichever window is in front, and ⌘Q
  asks every window before the app quits.
  - New Folder gives up ⇧⌘N (it's in the tree's context menu, where it acts
    on a folder you picked), matching how macOS apps that already spend ⌘N on
    a new document assign ⇧⌘N to New Window.

### Fixed — data safety

- Discarding changes to a file whose name contains `*` or `?` also reverted
  every other file the wildcard happened to match — throwing away unsaved
  work in documents you never touched. Git treats a pathspec as a glob; it
  now receives every path literally.
- The discard dialog promises exactly what will happen: a renamed file has no
  committed version under its new name, and the dialog now says "Move to
  Trash" instead of promising a restore it can't deliver.
- Two overlapping saves could publish a half-written file (they shared one
  temp name). Saves through a symlink replaced the link with a regular file.
- Quitting could force-quit *through* the unsaved-draft dialog after 20
  seconds, and abandoned slow saves after 3. The app now waits as long as a
  dialog needs — the only force-quit left is for a webview that never answers.
- Every filesystem command is scoped to dialog-granted folders and files —
  defense-in-depth so nothing running in the window can leave the workspace.
- "Open Recent ▸ Clear Menu" no longer revokes access to the folder you have
  open, which had made the next launch lose the workspace and every tab.

### Fixed — things that silently didn't work

- Workspaces opened through a symlink (`/tmp/…` included) never received file
  watching or git auto-refresh.
- Apps launched from Finder couldn't find Homebrew's git — and without the
  developer tools installed, macOS popped its "install developer tools?"
  dialog on every save.
- `git status` no longer re-triggers the watcher that triggered it; badges
  survive `git gc`; submodules with dots in their names are seen; nested
  submodules stop re-reporting suppressed noise.
- A stale network mount in the recents list froze the app at launch.
- Deleting the open workspace now says so instead of showing a stale tree.

### Changed

- The automatic update check offers a toast with an Update button instead of
  a modal dialog shortly after launch.
- Menu items grey out when there is nothing for them to act on; ⇧⌘W closes
  the window; a Help menu links to GitHub; Go to Heading (⇧⌘O) opens the
  document outline; duplicate folder names in Open Recent are disambiguated.
- The tab strip is fully keyboard-accessible; tree deletion is ⌘⌫ (a bare
  Backspace no longer offers to trash a file); renaming to a different
  extension is respected; Escape in the palette no longer closes panels
  behind it.
- Faster: git refreshes patch tree badges in place instead of rebuilding the
  sidebar on every save, and the status bar stops re-serializing the whole
  document on every keystroke.

## 0.1.1 — 2026-07-25

- A tiny release to prove the self-update pipeline end to end: if you're
  reading this from inside mad after clicking **Check for Updates…**, it
  worked.
- Fixed two bugs in the release tooling: `set-version` now updates
  `Cargo.lock` (release builds no longer start from a dirty tree) and is
  idempotent when re-run with the current version.

## 0.1.0 — 2026-07-25

First public release.

- WYSIWYG markdown editing (Milkdown Crepe) with raw-source and split views,
  Mermaid diagrams, image paste/drop, spell-check toggle and HTML export.
- Workspace sidebar with git status badges, per-file diff view, discard,
  rename/move/duplicate/trash, drag & drop, and full keyboard navigation.
- Quick Open, command palette, in-document find & replace, and parallel
  full-text search across the workspace.
- Atomic, conflict-detecting saves; live reload when files change on disk;
  session restore; light and dark themes.
- Signed self-updates via **mad ▸ Check for Updates…**.
