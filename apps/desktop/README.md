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
| `corepack pnpm e2e` | Builds, then drives the app with Playwright: the shell checks (`e2e/app.spec.ts`) and a tour of every screen, decision card and the delete dialog that saves screenshots in both themes to `e2e/screenshots/tour/` (`e2e/tour.spec.ts`), both on the mock engine; the real engine against the fake model server from `packages/mock-model`, through a relaunch (`e2e/real-engine.spec.ts`); the side panes and a worktree session against a real git repository (`e2e/panes.spec.ts`); and the everyday features on the real engine, with a model that can see: `@` mentions, an image, a rule added in Settings → Permissions, the Dock badge and a notification, the command palette and shortcuts (`e2e/daily-use.spec.ts`); quitting mid-turn and launching again, with a permission, a question and a plan card pending and a reply streaming, then queued and held messages (`e2e/resume.spec.ts`); and two worktree sessions running at once on one model's slot (`e2e/two-sessions.spec.ts`); the web tools: a WebFetch of an address on this Mac refused with the reason in the transcript, Settings → Web set to a local SearXNG stand-in, and a later session's WebSearch asking first and listing its results (`e2e/web.spec.ts`); MCP: a project's stdio test server approved in the trust dialog, a scripted call to `mcp__test__echo` asking first and showing the server's answer, and Settings → MCP servers listing it (`e2e/mcp.spec.ts`); rewind: a file the model edits in two turns, put back by Esc twice and "Restore files and conversation" at the first checkpoint, the window moved to the fork with its marker and the prompt back in the composer, the original kept, then `/memory` showing the project's memory in the Files pane (`e2e/rewind.spec.ts`). CI runs them all on Apple Silicon |

Lint runs from the repo root: `pnpm lint` (Biome).

Environment: `DAWG_HOME` moves the data root (default `~/.dawg`); `DAWG_MOCK_SPEED` speeds up
the mock engine's playback (`1` is recorded timing, `Infinity` is instant).

| Variable | Effect |
| --- | --- |
| `DAWG_ENGINE` | `mock` runs the mock engine and serves the mock models (`src/shared/mock-models.ts`); anything else, or unset, is the real engine and model manager |
| `DAWG_TEST_SERVER_URL` | For end-to-end tests: an OpenAI-compatible server (such as `packages/mock-model`) added as a remote server without a key, its first model the default. The scan for existing models and the Ollama and LM Studio probes are skipped, so nothing slow runs at start |
| `DAWG_TEST_SERVER_SLOTS` | `1`: sessions share the test server's slots as they share the bundled runtime's (one conversation slot), so they queue for it (`e2e/two-sessions.spec.ts`) |
| `DAWG_MOCK_LONG_SESSION` | With `DAWG_ENGINE=mock`: adds a synthetic session of that many transcript items (100 to 50,000), "Ledger: a long day of work" in `~/code/ledger` (`src/mock-engine/long-session.ts`), for the performance tests |
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
- **The helper model** (`src/main/models/manager.ts`) is the catalog's tiny `role: "helper"` entry
  (MiniCPM5 1B): a second llama-server, under its own supervisor and watchdog, with its own port,
  key, logs (`helper-runtime.log`, `helper-llama-server.log`) and one 32K slot. It answers side
  requests (session titles, WebFetch's page summaries) so they never wait for the main model or
  take its slots, whatever the main model is (bundled, Ollama, LM Studio or remote). It starts
  with the main model, when it is downloaded and on (Settings → Models; the choice is in
  `<data root>/helper-model.json`, which the command line follows too), unloads with the
  idle-unload setting and is restarted by its supervisor if it dies. Grants carry its endpoint
  while it is ready; the engine host sends side requests there and falls back to the main model,
  saying so in its log, when it does not answer. Its memory (weights, its cache, 512 MiB) is
  taken off the budget before the main model's window is chosen, so it is offered from 48 GB.
- **Renderer** (`src/renderer`) reaches all of the above through `getBridge()` only. In a plain
  browser (the Vite dev server) `getBridge()` falls back to an in-memory bridge whose engine is the
  mock engine running in the page.

## Layout

| Folder | Holds |
| --- | --- |
| `src/shared` | Contracts used on both sides: the bridge API and schemas, the main ⇄ engine host messages, mock model data |
| `src/main`, `src/preload`, `src/engine-host` | The Electron side |
| `src/main/models` | The model manager: state, downloads, the bundled runtime, servers and their keys |
| `src/main/web` | Settings → Web: the search service WebSearch uses. The choice (and a SearXNG address) is in `<data root>/web-search.json`, which the command line reads too; Brave Search and Tavily keys are encrypted with `safeStorage` in `<data root>/search-keys.json` and never sent back to a window. Main hands the engine host the service with its key in a `web-config` message (`shared/engine-host-messages.ts`) as soon as the host starts, before any window connects, and after every change; sessions opened from then on offer WebSearch when one is set. The page is `renderer/settings/WebPage.tsx`; WebFetch and WebSearch cards are `renderer/transcript/WebToolBodies.tsx` |
| `src/main/workspace` | Git and files for the panes (changes, diffs, reverts, listing, saving, watching), limited to a session's directories, worktrees, and the file index behind `@` mentions (`file-index.ts`, ranked by `src/shared/fuzzy.ts`) |
| `src/main/notifications.ts` | macOS notifications and the Dock badge; windows decide when to ask (`src/renderer/state/attention.ts`) |
| `src/main/terminal` | The person's shells (`node-pty`), batched to windows, with a backlog for reloads |
| `src/engine-host` | The engine switch (`engine.ts`), the real engine (`real-engine.ts`) and its model provider |
| `src/mock-engine` | The mock engine, its recorded sessions (`fixtures/`) and the recording format |
| `src/renderer/bridge` | `getBridge()` and the in-memory bridge |
| `src/renderer/state` | Event reducer, Zustand store, selectors, engine connection (`types.ts` is the contract) |
| `src/renderer/app` | Window layout: title bar, panes dock, notices, theme |
| `src/renderer/app/commands`, `app/palette` | Every action and its shortcut in one registry (`commands/registry.ts`), which drives the window's shortcuts, the command palette (⌘K), Settings → Shortcuts, and the menu bar and Dock menu (`commands/menu.ts`, shown by `src/main/menu.ts`) |
| `src/renderer/sidebar`, `composer`, `settings` | Those parts of the window (the composer's `@` menu is `composer/MentionMenu.tsx` and its images `composer/images.ts`; Settings → Models is `settings/ModelsPage.tsx`; Settings → Permissions is `settings/PermissionsPage.tsx`, which edits dawg's settings files through `src/main/permissions.ts`; a worktree session's personal settings are its project's, so "Personal for this project" reaches it too) |
| `src/renderer/onboarding`, `models` | The first run (welcome, download, start) and the model pieces it shares with Settings |
| `src/renderer/panes` | The side panes, one folder each (`changes`, `files`, `terminal`, `plan`, `tasks`), registered in `panes/index.ts` |
| `src/renderer/code` | Monaco, loaded on first use, with its worker, themes and the editor and diff components the panes share |
| `src/renderer/transcript`, `cards`, `markdown` | Transcript items, decision cards, streaming Markdown |
| `src/renderer/rewind` | The rewind dialog (Phase 4, "Checkpoints and rewind"): Esc twice in the empty composer while nothing runs, `/rewind` typed in the composer (caught before it is sent; the engine's command only lists, for other clients), or the palette's "Rewind to an earlier point…". It lists `session.checkpoints` newest first (each message, its time and the files its turn changed, those a subagent changed marked with it) and offers restore files and conversation, restore conversation, restore files (only with files to put back) and summarise from here, with 1 to 4; Esc goes back a step. Files changed outside dawg since stop it with a question before overwriting. It says that shell commands are not tracked, with a way to the Changes pane. `session.rewind` with the conversation opens a fork from before the message: the window moves to it with the message back in its composer, and the original stays in the sidebar. A forked session's transcript shows where its own conversation starts (`transcript/ForkMarker.tsx`): "Rewound from “…”" just before its first new message, or "Forked from" a plain fork, with "Open the original" |
| `/memory` | Runs the engine's `memory` command (its listing goes in the transcript; it makes the project's memory folder and an empty MEMORY.md), then shows the folder in the Files pane with MEMORY.md open: tracking asks main for `memory`, and main adds the folder as a read and write root of that session, named "Project memory". Main works the folder out itself from the session's project and the data root (`memoryDirectory` from `@dawg/engine`, loaded when first needed): a window never sends that path, so it cannot widen what the panes may touch. Chosen over opening the files in the person's editor because the Files pane already edits a session's files with save conflicts handled, and keeps the person in the app. Instruction files inside the project are already in the Files pane; the person's own `~/.claude/CLAUDE.md` is listed, not opened, since dawg never writes under `.claude/` |
| `src/renderer/trust` | The project trust dialog: the hooks (later MCP servers) a project supplies, approved or put off before they run (`project.inspect`, `project.trust`); it opens by itself the first time a project's session is shown with code waiting, and on `hook.skipped`. Settings → Hooks is `settings/HooksPage.tsx` (`hooks.list`, `hooks.setEnabled`); hook lines in the transcript are `transcript/HookView.tsx`. Settings → Skills and commands is `settings/SkillsPage.tsx` (`project.skills`); the composer's `/` menu tags a custom command or skill "personal" or "project" |
| Subagents | A session's agents come from `subagent.updated` (`state/reducer.ts`, kept per session and on the call that started each task). The `Agent`, `SendMessage` and forked `Skill` calls draw as `transcript/AgentCard.tsx`; "Open transcript" shows the agent's own session read-only in place of its parent's (`app/SubagentPanel.tsx`), read with `session.replay` on the agent's session and again on each update while it shows. Background agents are listed in the Tasks pane with Stop (`subagent.stop`). A permission card an agent raised names it. The mock engine scripts an Explore agent for any prompt that asks for an agent (`src/mock-engine/subagents.ts`); `e2e/subagents.spec.ts` runs one on the real engine |
| `src/renderer/settings/McpPage.tsx` | Settings → MCP servers: each server's source, transport, state and tools, restart and a switch (`mcp.list`, `mcp.restart`, `mcp.setEnabled`), and the import of Claude Code's servers after showing what would be copied (`mcp.importPreview`, `mcp.import`). MCP calls in the transcript are `transcript/McpToolBody.tsx`; the composer's `@` menu offers the session's resources and its `/` menu the servers' prompts (`mcp.session`, `composer/mcpResources.ts`). The mock engine's servers are `src/mock-engine/mcp.ts` |
| `src/renderer/settings/ProjectSetupPage.tsx` | Settings → Project setup: the compatibility report for a project and the home folder (`project.inspect`, through `actions.inspectProject`), grouped as Loaded, Needs approval, Partly supported, Not supported and Invalid, with the consent shown read-only and "Review…" opening the trust dialog. The first time a session's project with a Claude Code setup is shown, `state/project-setup.ts` says what was found in a notice that links there, once per project (`projectSetupNoticed` in the desktop settings). The mock engine's report is `src/mock-engine/compat.ts` |
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
- Each window saves its state to `<data root>/state.json` (`WindowStateSchema` in
  `src/shared/bridge.ts`, debounced in `src/renderer/state/window-state.ts`, and at once when the
  window goes): layout, selection, seen marks, and what the person typed and has not sent, so a
  quit loses none of it. That is each session's draft (with the paths its `@` menu inserted) and
  its queued and held messages, text and mentions. Images are not saved; the message says its
  images were not kept. After a relaunch every saved message is held, with Send now and Remove:
  nothing is sent without the person asking. Entries for sessions that are gone are dropped once
  the engine has listed the sessions. Fields are added with defaults, so older files still load.
- Colours come only from the variables in `src/renderer/styles/tokens.css`. Dark is the default;
  `<html data-theme="light">` switches. Every component is tested in both themes.
- Fonts are the macOS system fonts (SF Pro, SF Mono); nothing is bundled.
- Styles are CSS modules next to their components; shared pieces are in `src/renderer/ui`.
- Relative imports carry their `.ts` / `.tsx` extension.

## Performance

The Phase 3 budgets, and one of our own, are asserted by `e2e/performance.spec.ts` on the mock
engine with a 5,000-item session (`DAWG_MOCK_LONG_SESSION=5000`: prompts, Markdown answers with
code, reasoning, reads, searches, edits with diffs, command output, interrupted turns,
compactions and answered decisions) and a temporary git repository. `PERF_PROFILE_DIR=<dir>`
also writes CPU profiles of the open and the stream there and prints where the time went. On CI
(GitHub's shared macOS runners, which render through a virtual GPU) every time budget gets twice
the room and the spec retries once; the numbers below are the strict ones, for a real Mac.

Measured on the reference laptop for this work, a 2019 Intel MacBook Pro (i7-8557U, 16 GB), with
other work running; ranges are several runs.

| Budget | Before | After | Asserted |
| --- | --- | --- | --- |
| Window visible, from the process starting | 1.05–1.3 s | 0.85–1.04 s | < 2 s (the spec) |
| Open a 5,000-item session: newest items painted | 2.5–8.1 s | 0.28–0.30 s | < 1 s |
| … longest main-thread task while it opens and draws the rest | 1.8–6.4 s | none over 50 ms | < 300 ms |
| … the whole session drawn, in the background | (with the above) | 2.0–2.2 s | < 20 s |
| Scrolling it (3,600 px/s): 95th percentile frame, worst frame | 34–161 ms, 39–243 ms | 18 ms, 19–21 ms | < 25 ms; at most 1 frame in 200 over 100 ms |
| Text streaming into it: 95th percentile frame | 118 ms (about 10 frames a second) | 19–20 ms | < 25 ms |
| … transcript commits per frame, and what a delta makes React visit | 1, all 5,000 items | 1, one group of 25 | 1, at most 2 groups touched |
| A 5,000-line diff (1,000 hunks) in Changes: drawn, longest task | 0.18–0.34 s, up to 168 ms | 0.17–0.18 s, none | < 2 s, < 300 ms |

What changed:

- **The transcript** (`src/renderer/transcript/Transcript.tsx`) draws items in memoised groups of
  25. Each group is a `content-visibility: auto` box, so the browser lays out and paints only
  what is near the screen; a delta re-renders one group and its item. A session opens with its
  newest 30 items, then draws older ones in steps of 50 as React transitions while the window is
  idle. Everything stays in the page (no windowing), so selection across items, VoiceOver's
  reading order, the cards' shortcuts and "Show the card again" work as before. The groups'
  `overflow-clip-margin` keeps shadows and focus rings from being cut at their edges.
- **The reducer** found items by scanning the transcript, so each new item read all the others:
  replaying 5,000 items took 0.42 s and 10,000 took 1.8 s. Lookups now go through an index
  (`src/renderer/state/item-index.ts`): 30 ms and 65 ms.
- **Startup**: run from a checkout, main set the Dock icon from the 1,024 px artwork, which held
  the window back by 0.35–0.6 s; it now uses a 256 px copy. Main logs the time to the window
  showing, from the process starting.
- **The large diff** needed nothing: main diffs with git, Monaco diffs in its worker and folds
  unchanged lines, and a whole-file rewrite of 6,000 lines draws as quickly.

Why the budgets are what they are: GitHub's Apple Silicon runners are two to three times as fast
as this laptop. The opening budget (1 s) is over three times this laptop's figure and still
below what the old transcript took on a faster machine; the 300 ms task limit is a pause a person
notices, far from the multi-second freezes before. The frame budgets allow one late frame in
twenty, at 60 Hz or faster; the old transcript missed them several times over. The diff budgets
guard against a regression that would freeze the window, and the window's 2 s is the spec's.

Not yet done, found on the way: replies to `session.replay` are validated with zod event by event,
about 0.3 s of a 5,000-item open on this laptop (`packages/protocol`), and streamed Markdown is
parsed again in full for every frame of a long answer (`src/renderer/markdown`).
