import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Node environment, not jsdom, and deliberately so.
 *
 * The only frontend module with logic worth unit-testing is `lib/analytics.ts`,
 * and it was written to take its storage as an argument precisely so it can be
 * driven without a DOM. Adding jsdom to get `localStorage` would pull a large
 * dependency into a frontend that has never had a test runner at all, to test
 * code that does not need it.
 *
 * Only `lib/` is included. Component testing would need jsdom and React
 * Testing Library; the components here are verified in a real browser instead,
 * per `docs/superpowers/specs/2026-08-22-google-analytics-design.md`.
 */
export default defineConfig({
  // The `@/` alias from tsconfig, which vitest does not read on its own. Added
  // for the share-card route tests (`lib/share-routes.test.ts`), which import
  // route handlers written in the app's usual `@/lib/...` style rather than
  // rewriting them to relative paths for the test runner's sake.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/lib/**/*.test.ts"],
  },
});
