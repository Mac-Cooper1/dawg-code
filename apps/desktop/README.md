# @dawg/desktop

The dawg-code app: Electron main process, a sandboxed React renderer, and an engine host that
serves the engine protocol (`@dawg/protocol`). Spec: `docs/specs/phase-3-desktop-app.md`. The
visual design was approved on 2026-11-22 (see "Visual design" in the spec).

The engine host runs the **real engine** (`@dawg/engine`), and main runs the **model manager**
(`src/main/models`, on `@dawg/models`): the hardware probe, the catalog and its recommendation,
downloads, copies other apps already have, Ollama, LM Studio and remote servers, and the bundled
`llama-server`. A first run shows the welcome screen, which downloads and starts the recommended
model in one click; Settings → Models manages the rest.

`DAWG_ENGINE=mock` runs the **mock engine** instead, which replays recorded sessions against the
mock models; the end-to-end tour uses it. The mock engine sends everything the real one does:
queue positions, the mode a plan returns to, command output apart from what the model is told,
the context's split and compaction threshold, and `session.delete`. Its recordings are written by
`node src/mock-engine/record/write-fixtures.ts`; do not edit them by hand.

Before running the real engine in a checkout, fetch the pinned binaries from the repo root:
`pnpm fetch-runtime` (llama-server into `resources/runtime/<arch>/`) and `pnpm fetch-ripgrep`
(ripgrep into `resources/bin/<platform>-<arch>/`).

## Commands

Run from this folder (pnpm runs through corepack: `corepack pnpm …`).

| Command | What it does |
| --- | --- |
| `corepack pnpm dev` | Opens the app with hot reload (`electron-vite dev`) |
| `corepack pnpm build` | Bundles main, preload, engine host and renderer into `out/` |
| `corepack pnpm start` | Runs the built app |
| `corepack pnpm typecheck` | `tsc` over the Node side and the web side |
| `corepack pnpm test` | Vitest: `*.test.ts` in Node, `*.test.tsx` components in jsdom |
| `corepack pnpm e2e` | Builds, then drives the app with Playwright: the shell checks (`e2e/app.spec.ts`) and a tour of every screen, decision card and the delete dialog that saves screenshots in both themes to `e2e/screenshots/tour/` (`e2e/tour.spec.ts`), both on the mock engine; the real engine against the fake model server from `packages/mock-model`, through a relaunch (`e2e/real-engine.spec.ts`); the side panes and a worktree session against a real git repository (`e2e/panes.spec.ts`); and the everyday features on the real engine, with a model that can see: `@` mentions, an image, a rule added in Settings → Permissions, the Dock badge and a notification, the command palette and shortcuts (`e2e/daily-use.spec.ts`). CI runs them all on Apple Silicon |

Lint runs from the repo root: `pnpm lint` (Biome).

Environment: `DAWG_HOME` moves the data root (default `~/.dawg`); `DAWG_MOCK_SPEED` speeds up
the mock engine's playback (`1` is recorded timing, `Infinity` is instant).

| Variable | Effect |
| --- | --- |
| `DAWG_ENGINE` | `mock` runs the mock engine and serves the mock models (`src/shared/mock-models.ts`); anything else, or unset, is the real engine and model manager |
| `DAWG_TEST_SERVER_URL` | For end-to-end tests: an OpenAI-compatible server (such as `packages/mock-model`) added as a remote server without a key, its first model the default. The scan for existing models and the Ollama and LM Studio probes are skipped, so nothing slow runs at start |
| `DAWG_CATALOG` | A catalog file to use instead of the bundled `catalog/catalog.json` |
| `DAWG_RUNTIME_BIN` | Another `llama-server` binary instead of `resources/runtime/<arch>/llama-server` |
| `DAWG_RUNTIME_TESTS` | `1` also runs the tests that load a real model with the pinned runtime (`.cache/test-models`) |

To try the real engine without downloading a model, start the fake model server and point the
app at it: `node packages/mock-model/src/cli.ts --script <file.json> --port 0` prints its
`baseUrl`; then run the app with `DAWG_TEST_SERVER_URL=<baseUrl>`.

In a plain browser (the renderer served by Vite, with the in-memory bridge), `?models=none`
starts with nothing installed, so the welcome screen shows, and `?models=small` pretends to be a
16 GB Mac that no catalog model fits. Without it, every mock model is installed.

The model manager (`src/main/models`) keeps what it installs in `<data root>/models.json`, and
remote servers' keys encrypted with the Keychain (Electron's `safeStorage`) in
`<data root>/server-keys.json`. Downloads go to the shared Hugging Face cache. The workspace
service keeps each session's base commit (what the Changes pane compares with) in
`<data root>/workspace.json`.

## Processes

```
Renderer (React, sandboxed) ──typed preload API──▶ Main ──▶ settings, window state, dialogs, models
       │
       └────── MessagePort (JSON-RPC) ──────────▶ Engine host (utility process) ──▶ engine ──▶ llama-server, servers
```

- **Main** (`src/main`) owns windows, menus, settings files, the model manager and the engine
  host. It hands each window a `MessagePort` straight to the engine host, so streamed events never
  pass through main, and restarts the engine host if it dies. The bundled `llama-server` runs
  under the models package's watchdog (built to `out/main/watchdog.js`), so it never outlives the
  app, even after a crash.
- **Preload** (`src/preload`) exposes `window.dawgPreload` through `contextBridge`. Every input is
  validated against the schemas in `src/shared/bridge.ts`, and again in main.
- **Engine host** (`src/engine-host`) serves the protocol on each port it is given. When a
  session needs a model it asks main over the parent port (`src/shared/engine-host-messages.ts`);
  main loads it if needed and answers with where to send requests and, for the bundled runtime,
  the slots the engine shares between sessions.
- **Renderer** (`src/renderer`) reaches all of the above through `getBridge()` only. In a plain
  browser (the Vite dev server) `getBridge()` falls back to an in-memory bridge whose engine is the
  mock engine running in the page.

## Layout

| Folder | Holds |
| --- | --- |
| `src/shared` | Contracts used on both sides: the bridge API and schemas, the main ⇄ engine host messages, mock model data |
| `src/main`, `src/preload`, `src/engine-host` | The Electron side |
| `src/main/models` | The model manager: state, downloads, the bundled runtime, servers and their keys |
| `src/main/workspace` | Git and files for the panes (changes, diffs, reverts, listing, saving, watching), limited to a session's directories, worktrees, and the file index behind `@` mentions (`file-index.ts`, ranked by `src/shared/fuzzy.ts`) |
| `src/main/notifications.ts` | macOS notifications and the Dock badge; windows decide when to ask (`src/renderer/state/attention.ts`) |
| `src/main/terminal` | The person's shells (`node-pty`), batched to windows, with a backlog for reloads |
| `src/engine-host` | The engine switch (`engine.ts`), the real engine (`real-engine.ts`) and its model provider |
| `src/mock-engine` | The mock engine, its recorded sessions (`fixtures/`) and the recording format |
| `src/renderer/bridge` | `getBridge()` and the in-memory bridge |
| `src/renderer/state` | Event reducer, Zustand store, selectors, engine connection (`types.ts` is the contract) |
| `src/renderer/app` | Window layout: title bar, panes dock, notices, theme |
| `src/renderer/app/commands`, `app/palette` | Every action and its shortcut in one registry (`commands/registry.ts`), which drives the window's shortcuts, the command palette (⌘K) and Settings → Shortcuts |
| `src/renderer/sidebar`, `composer`, `settings` | Those parts of the window (the composer's `@` menu is `composer/MentionMenu.tsx` and its images `composer/images.ts`; Settings → Models is `settings/ModelsPage.tsx`; Settings → Permissions is `settings/PermissionsPage.tsx`, which edits dawg's settings files through `src/main/permissions.ts`; a worktree session's personal settings are its project's, so "Personal for this project" reaches it too) |
| `src/renderer/onboarding`, `models` | The first run (welcome, download, start) and the model pieces it shares with Settings |
| `src/renderer/panes` | The side panes, one folder each (`changes`, `files`, `terminal`, `plan`, `tasks`), registered in `panes/index.ts` |
| `src/renderer/code` | Monaco, loaded on first use, with its worker, themes and the editor and diff components the panes share |
| `src/renderer/transcript`, `cards`, `markdown` | Transcript items, decision cards, streaming Markdown |
| `src/renderer/ui`, `styles`, `lib` | Shared primitives, design tokens, formatting helpers |
| `e2e` | Playwright tests that drive the built app |

## Native modules

`node-pty` is the only one. It ships prebuilt binaries for macOS on arm64 and x64, built against
Node-API, so Electron loads them as they are and its install scripts stay off
(`allowBuilds` in `pnpm-workspace.yaml`). Version 1.1.0 ships its `spawn-helper` without the
executable bit; the terminal service sets it before the first shell starts. A packaged build
(Phase 5) must keep `node-pty` outside the asar archive.

## Conventions

- Everything the renderer shows is derived from protocol events and snapshots; it can be rebuilt
  by replaying a session. Only UI state (selection, layout, drafts, the client-side message queue)
  lives in the renderer alone.
- Colours come only from the variables in `src/renderer/styles/tokens.css`. Dark is the default;
  `<html data-theme="light">` switches. Every component is tested in both themes.
- Fonts are the macOS system fonts (SF Pro, SF Mono); nothing is bundled.
- Styles are CSS modules next to their components; shared pieces are in `src/renderer/ui`.
- Relative imports carry their `.ts` / `.tsx` extension.
