import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // jsdom because most of this code exists to manipulate a document: the
    // tree, the palette, the toasts and the diff panel are all DOM.
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // Every line here is glue we cannot execute under jsdom, and pretending
        // otherwise would mean asserting nothing while reporting a bigger
        // number. See CONTRIBUTING.md.
        //
        // main.ts is init(): DOM wiring, event plumbing and dynamic
        // `@tauri-apps/*` imports. Its decision logic is extracted into
        // covered modules (paths, diff, session, keys, updater) as it grows
        // testable seams — what remains here is untested orchestration, and
        // this exclusion is the honest record of that.
        "src/main.ts",
        // editor.ts constructs a Milkdown Crepe instance. Crepe needs real
        // layout, ranges and contenteditable behaviour that jsdom does not
        // implement; its pure helpers live in paths.ts and are covered there.
        "src/editor.ts",
        // Tauri IPC surface — invoke() only exists inside the app. The
        // browser mock lives in backend.mock.ts, which IS measured.
        "src/backend.ts",
      ],
      // A floor, not a target. Vitest 4's v8 provider maps coverage through
      // the AST rather than by line, so it counts defensive branches the old
      // provider silently credited — the same code measured lower without
      // anything getting worse. 95 leaves room for unreachable guards
      // (`Map.get() ?? []` and friends) while still failing loudly if real
      // coverage slips.
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
});
