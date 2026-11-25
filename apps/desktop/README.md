# @dawg/desktop

The dawg-code app: Electron main process, a sandboxed React renderer, and an engine host that
serves the engine protocol (`@dawg/protocol`). Spec: `docs/specs/phase-3-desktop-app.md`. The
visual design was approved on 2026-11-22 (see "Visual design" in the spec).

In this wave the engine host runs a **mock engine** that replays recorded sessions; the real
engine (`@dawg/engine`) plugs into the same place later. The mock engine sends everything the
real one will: queue positions, the mode a plan returns to, command output apart from what the
model is told, the context's split and compaction threshold, and `session.delete`. Its
recordings are written by `node src/mock-engine/record/write-fixtures.ts`; do not edit them by
hand.

## Commands

Run from this folder (pnpm runs through corepack: `corepack pnpm …`).

| Command | What it does |
| --- | --- |
| `corepack pnpm dev` | Opens the app with hot reload (`electron-vite dev`) |
| `corepack pnpm build` | Bundles main, preload, engine host and renderer into `out/` |
| `corepack pnpm start` | Runs the built app |
| `corepack pnpm typecheck` | `tsc` over the Node side and the web side |
| `corepack pnpm test` | Vitest: `*.test.ts` in Node, `*.test.tsx` components in jsdom |
| `corepack pnpm e2e` | Builds, then drives the app with Playwright: the shell checks (`e2e/app.spec.ts`) and a tour of every screen, decision card and the delete dialog that saves screenshots in both themes to `e2e/screenshots/tour/` (`e2e/tour.spec.ts`) |

Lint runs from the repo root: `pnpm lint` (Biome).

Environment: `DAWG_HOME` moves the data root (default `~/.dawg`); `DAWG_MOCK_SPEED` speeds up
the mock engine's playback (`1` is recorded timing, `Infinity` is instant).

## Processes

```
Renderer (React, sandboxed) ──typed preload API──▶ Main ──▶ settings, window state, dialogs, models
       │
       └────── MessagePort (JSON-RPC) ──────────▶ Engine host (utility process) ──▶ mock engine
```

- **Main** (`src/main`) owns windows, menus, settings files and the engine host. It hands each
  window a `MessagePort` straight to the engine host, so streamed events never pass through main,
  and restarts the engine host if it dies.
- **Preload** (`src/preload`) exposes `window.dawgPreload` through `contextBridge`. Every input is
  validated against the schemas in `src/shared/bridge.ts`, and again in main.
- **Engine host** (`src/engine-host`) serves the protocol on each port it is given.
- **Renderer** (`src/renderer`) reaches all of the above through `getBridge()` only. In a plain
  browser (the Vite dev server) `getBridge()` falls back to an in-memory bridge whose engine is the
  mock engine running in the page.

## Layout

| Folder | Holds |
| --- | --- |
| `src/shared` | Contracts used on both sides: the bridge API and schemas, mock model data |
| `src/main`, `src/preload`, `src/engine-host` | The Electron side |
| `src/mock-engine` | The mock engine, its recorded sessions (`fixtures/`) and the recording format |
| `src/renderer/bridge` | `getBridge()` and the in-memory bridge |
| `src/renderer/state` | Event reducer, Zustand store, selectors, engine connection (`types.ts` is the contract) |
| `src/renderer/app` | Window layout: title bar, panes dock, notices, theme |
| `src/renderer/sidebar`, `composer`, `settings` | Those parts of the window |
| `src/renderer/transcript`, `cards`, `markdown` | Transcript items, decision cards, streaming Markdown |
| `src/renderer/ui`, `styles`, `lib` | Shared primitives, design tokens, formatting helpers |
| `e2e` | Playwright tests that drive the built app |

## Conventions

- Everything the renderer shows is derived from protocol events and snapshots; it can be rebuilt
  by replaying a session. Only UI state (selection, layout, drafts, the client-side message queue)
  lives in the renderer alone.
- Colours come only from the variables in `src/renderer/styles/tokens.css`. Dark is the default;
  `<html data-theme="light">` switches. Every component is tested in both themes.
- Fonts are the macOS system fonts (SF Pro, SF Mono); nothing is bundled.
- Styles are CSS modules next to their components; shared pieces are in `src/renderer/ui`.
- Relative imports carry their `.ts` / `.tsx` extension.
