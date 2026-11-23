import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Two projects:
 * - `node`: `*.test.ts` anywhere (reducer, store, mock engine, main-process logic).
 * - `dom`: `*.test.tsx` under `src/renderer` (components, in jsdom, in both themes).
 */
export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/renderer/**/*.test.tsx"],
          setupFiles: ["src/renderer/test/setup.ts"],
        },
      },
    ],
  },
});
