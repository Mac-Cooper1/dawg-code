import { defineConfig } from "@playwright/test";

// Every app a test launches keeps MCP sign-ins in a file under its temporary data root, never in
// the person's Keychain. The specs pass this process's environment on to the app.
process.env.DAWG_CREDENTIAL_STORE = "file";

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
