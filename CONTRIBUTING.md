# Contributing

```bash
npm install
npm run tauri dev     # the real app
npm run dev           # the UI alone, in a browser, against a demo workspace
```

## Checks

```bash
npm run check         # everything CI runs
```

or individually:

| | |
| --- | --- |
| `npm test` | frontend unit tests (Vitest, jsdom) |
| `npm run test:watch` | the same, watching |
| `npm run test:coverage` | with coverage, and the thresholds enforced |
| `npm run test:rust` | Rust unit tests |
| `npm run lint` | `tsc --noEmit` plus `clippy -D warnings` |

CI runs all of it on every pull request, on Linux for the frontend and macOS for
Rust, plus a release build of the app because unit tests never link the binary or
run Tauri's build script.

The workflow deliberately uses **only first-party `actions/*` steps**. A
repository can be configured to allow nothing else, and a workflow that reaches
for a third-party action then fails at startup with no log to explain itself —
which is exactly what happened the first time this landed. Rust is set up with
plain `rustup` calls instead, and `cargo-llvm-cov` is fetched as a prebuilt
binary. Please keep it that way.

## Where the tests live

Frontend tests sit beside the module they cover — `src/paths.ts` →
`src/paths.test.ts`. Rust tests are in the `mod tests` block at the bottom of
`src-tauri/src/lib.rs`.

## What coverage means here

The frontend modules under test are at **100% statements, functions and lines**,
and 99.75% branches. Thresholds in `vitest.config.ts` fail the build on a
regression, so this doesn't quietly rot.

The number is only worth reading if you know what it covers, so:

**Excluded, deliberately.** Three files are outside the measurement because they
cannot execute under jsdom, and including them would mean asserting nothing while
reporting a bigger number:

- **`src/main.ts`** — one long `init()` of DOM wiring plus dynamic
  `@tauri-apps/*` imports. Its logic was extracted into `paths.ts`, `diff.ts` and
  `session.ts`, which are covered directly. What remains is glue.
- **`src/editor.ts`** — constructs a Milkdown Crepe instance, which needs real
  layout, `Range` behaviour and `contenteditable` that jsdom does not implement.
  Its pure helpers live in `paths.ts` and are covered there. The editor's own
  behaviour is verified by driving the running app in a browser.
- **`src/backend.ts`** — the Tauri IPC surface; `invoke()` only exists inside the
  app. The in-memory mock half of the file *is* covered, via
  `src/backend.test.ts`.

**The one unreachable branch** is a `Map.get(...) ?? []` in `tree.ts`. The type
says the lookup can miss; no call path lets it. Contorting the design to reach it
would be worse than leaving it, so the branch threshold is 99 rather than 100.

**Rust sits at ~72% of lines**, and the missing third is the Tauri app shell —
none of it reachable from a unit test:

- `run()` — the `tauri::Builder` chain and the `ExitRequested` quit flow.
- `rebuild_menu()` and the menu event routing — every item needs an `AppHandle`,
  and the accelerators are validated by the OS at install time.
- `pick_folder`, `confirm`, `confirm_choice`, `message`, `save_dialog`,
  `export_dialog` — these block on a native dialog waiting for a human.
- `reveal_path`, `open_path` — these hand off to Finder and the OS.
- `watch_folder` and its debounce thread — needs a live event loop to emit into.
- `set_menu_state`, `push_recent` — take an `AppHandle`.

Everything *else* in `lib.rs` is tested: atomic writes and their permission and
conflict behaviour, path traversal in image names, the listing filters, search
(including character offsets and regex failure), git porcelain parsing, submodule
descent, discard semantics, and the recents list. Several of those tests build a
real git repository — with a real submodule — and shell out to `git`.

If that shell needs to read as covered too, the move is to split `lib.rs` into a
logic module and an `app.rs` shell and exclude the latter by name. It is a
mechanical change nobody has needed yet.

## Style

The Rust and TypeScript here explain *why*, not *what* — several comments exist
only because a bug hid there once, and they should stay. `cargo fmt` and the
existing formatting are the whole style guide; there is no linter config to argue
with.
