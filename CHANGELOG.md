# Changelog

Notable changes per release. mad follows [semver](https://semver.org) as far as
a 0.x app can: expect minor-version bumps for features, patch bumps for fixes.

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
