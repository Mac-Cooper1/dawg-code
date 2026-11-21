import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tool tests spawn real processes (shell commands, ripgrep) and wait on timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
