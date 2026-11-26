import { createHash } from "node:crypto";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

const root = import.meta.dirname;

/**
 * Workspace packages ship TypeScript source, and Node does not strip types from files under
 * node_modules, so they (and zod, which they share with main) are bundled, never loaded at run
 * time. Other dependencies stay external in main so native modules (node-pty, later) still work.
 */
const BUNDLED_DEPENDENCIES = [
  "@dawg/compat",
  "@dawg/engine",
  "@dawg/models",
  "@dawg/protocol",
  "zod",
];

/**
 * The page's Content-Security-Policy allows only scripts from 'self'. In the dev server,
 * @vitejs/plugin-react injects an inline module script (the React Refresh preamble), which that
 * policy blocks. This adds the hash of every inline script in the served page to `script-src`,
 * in dev only, so the built app keeps the strict policy and dev keeps hot reload.
 */
function allowDevInlineScripts(): Plugin {
  return {
    name: "dawg:allow-dev-inline-scripts",
    apply: "serve",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const hashes: string[] = [];
        for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
          const [, attributes = "", body = ""] = match;
          if (/\bsrc=/.test(attributes) || body.length === 0) continue;
          hashes.push(`'sha256-${createHash("sha256").update(body).digest("base64")}'`);
        }
        if (hashes.length === 0) return html;
        return html.replace(/script-src 'self'/, `script-src 'self' ${hashes.join(" ")}`);
      },
    },
  };
}

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: BUNDLED_DEPENDENCIES },
      rolldownOptions: {
        input: {
          index: resolve(root, "src/main/index.ts"),
          "engine-host": resolve(root, "src/engine-host/index.ts"),
          // The runtime supervisor's watchdog, a script of its own: main runs it from
          // out/main/watchdog.js so llama-server never outlives the app (see src/main/models).
          watchdog: resolve(root, "../../packages/models/src/runtime/watchdog.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      // A sandboxed preload cannot load ES modules or anything from disk: one CommonJS file.
      externalizeDeps: false,
      rolldownOptions: {
        input: { index: resolve(root, "src/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(root, "src/renderer"),
    plugins: [react(), allowDevInlineScripts()],
    build: {
      rolldownOptions: {
        input: resolve(root, "src/renderer/index.html"),
      },
    },
  },
});
