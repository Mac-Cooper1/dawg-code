import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests run the command-line tool as a child process against a scripted model server.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
