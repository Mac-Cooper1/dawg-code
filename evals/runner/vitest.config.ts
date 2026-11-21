import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several tests run whole tasks (git, bash, child processes) end to end.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
