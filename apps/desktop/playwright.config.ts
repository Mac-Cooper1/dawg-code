import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests drive the built app (`out/`) through Playwright's Electron support.
 * `corepack pnpm e2e` builds first. One worker: each test launches a whole app.
 */
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "test-results",
});
