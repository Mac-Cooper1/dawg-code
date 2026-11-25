# Phase 3 — Desktop app

_Draft spec. Roadmap: [PLAN.md](../../PLAN.md) section 9. Shared conventions: [README](README.md)._

## Outcome

The app a person actually works in all day: a sidebar of sessions, a streaming transcript with tool activity and permission prompts, and side panes for changes, files, a terminal, the plan and tasks. Someone who knows Claude Code's desktop app finds everything where they expect it, with our own visual design.

## Scope

**In**

- App architecture: main, preload, renderer, engine host.
- Session sidebar, transcript, composer.
- Permission, question and plan-approval UI.
- Panes: Changes, Files, Terminal, Plan, Tasks.
- A git worktree per session.
- Notifications, settings, keyboard shortcuts, command palette.

**Out**

- Browser preview pane, split view, PR and CI status (Phase 5).
- UI for hooks, skills, subagents and MCP beyond what the protocol already carries (added with those features in Phase 4).
- Signing, notarization, auto-update (Phase 5).

## Depends on

- Phase 1: the Electron shell, preload bridge and model screens.
- Phase 2: the protocol. UI work starts against a mock engine that replays recorded event streams, and switches to the real engine as it lands.

## Design

### Architecture

```
Renderer (React) ──typed preload API──▶ Main ──▶ terminals, git, files, updater, model manager
       │
       └────── message port ──────────▶ Engine host (utility process) ──▶ llama-server
```

- The main process starts the engine host and hands the renderer a direct message port to it, so streamed events do not pass through main.
- The engine host is restarted if it dies. Sessions resume from their transcripts, and the UI shows a one-line notice.
- The renderer holds no source of truth: everything it shows is derived from protocol events and can be rebuilt by replaying a session.

**Renderer stack**

| Concern             | Choice                                                                |
| ------------------- | --------------------------------------------------------------------- |
| Framework and build | React, Vite                                                           |
| State               | A normalised client store (Zustand), fed by a single event reducer    |
| Styling             | CSS variables for design tokens; dark and light themes (see below)    |
| Primitives          | Headless accessible components (Radix) with our own styling           |
| Code and diffs      | Monaco                                                                |
| Terminal            | xterm.js in the renderer, node-pty in main                            |
| Markdown            | A streaming-safe renderer with syntax highlighting; raw HTML disabled |
| Long lists          | Virtualised                                                           |

### State model

```ts
interface AppState {
  projects: Record<ProjectId, Project>; // a folder on disk
  sessions: Record<SessionId, SessionView>; // title, status, unread, mode, model, worktree
  transcripts: Record<SessionId, Item[]>; // messages, tool calls, notes, in order
  pending: Record<SessionId, Request[]>; // permission / question / plan awaiting an answer
  layout: Layout; // open panes, sizes, selected session
}
```

One reducer turns protocol events into state changes. The same reducer runs in tests against recorded event streams.

### Visual design

Approved on 2026-11-22 from a clickable mockup of first run, the main window, decision cards, the panes and Settings, each in dark and light: https://claude.ai/artifact/Az8BmEJRkbGRkmTxpPKoyN (private to the project owner).

- **Themes.** Dark and light are both first-class: every screen is designed and tested in both, and designs are shown dark first. Settings → General → Appearance offers Match macOS (the default), Dark and Light. A moon or sun button in each window's title bar switches between Dark and Light and saves that choice.
- **Colour.** Graphite neutrals and one lime accent. The accent fills primary buttons and marks selection. On light backgrounds, accent-coloured text and progress bars use dark olive so they stay readable.

| Token                    | Light                                      | Dark                                       |
| ------------------------ | ------------------------------------------ | ------------------------------------------ |
| Window background        | `#F7F7F4`                                  | `#131416`                                  |
| Sidebar and title bar    | `#EEEEE9`                                  | `#18191C`                                  |
| Panels and cards         | `#FFFFFF`                                  | `#1E1F23`                                  |
| Lines                    | `#E2E2DB`                                  | `#2C2E33`                                  |
| Text, secondary, muted   | `#17181A`, `#45484D`, `#61656C`            | `#ECEDEF`, `#B9BCC2`, `#90949B`            |
| Accent fill, accent text | `#C8F03C`, `#4A6600`                       | `#C8F03C`, `#C8F03C`                       |
| Amber, blue, red, green  | `#A34A00`, `#1D5BD1`, `#C2261E`, `#1A7536` | `#F6B44A`, `#7EA8FF`, `#FF7B72`, `#6CD38D` |

- **Status colours.** Amber means "Needs you", blue means done-unread and cached tokens, red means an error, green means success.
- **Logo and app icon.** A lime line-art bulldog head on graphite, chosen by the project owner on 2026-11-24. The artwork is the owner's vector, `apps/desktop/resources/brand/logo.svg`. The app icon (`resources/icon.icns`, `resources/icon.png`) is made from it: the artwork's centre on a rounded graphite tile on Apple's 1024 grid, with a soft shadow.
- **Type.** UI text at 13 px, code at 12 px in a monospace face. The mockup uses Geist and Geist Mono; see Open questions.
- **Status marks** differ in shape as well as colour: a spinning ring (working), an amber "!" (needs you), a blue dot (done, unread), a dashed ring (queued), a red × (error), and no mark (idle).
- **Tool calls** open "what needs a look" by default: failed commands and edits are open; reads, searches and passing commands are closed. Settings → General also offers All closed and All open.
- **Decision cards** appear inline in the transcript where the agent stopped, and the session's sidebar row says what is needed ("Needs you: run a command"). Text sent from the composer while a card is open answers that card: it denies the command with that note, answers the question, or keeps planning with that feedback. An answered card leaves a one-line record with "Show the card again".
- **Stopping a turn** holds any queued message. It stays above the composer, unsent, with Send now and Remove.

### Window layout

```
┌──────────┬──────────────────────────────┬──────────────────┐
│ Sidebar  │ Transcript                   │ Pane dock        │
│          │                              │ Changes | Files  │
│ sessions │                              │ Terminal | Plan  │
│ by       │                              │ Tasks            │
│ project  ├──────────────────────────────┤                  │
│          │ Composer                     │                  │
└──────────┴──────────────────────────────┴──────────────────┘
```

Sidebar and dock are resizable and collapsible. Layout is remembered per window.

### Sidebar

- Sessions grouped by project, newest activity first. Search by title.
- Each row shows the title and a status mark:

| Status       | Meaning                                            |
| ------------ | -------------------------------------------------- |
| Working      | The agent is running                               |
| Needs you    | Waiting on a permission, question or plan approval |
| Done, unread | Finished since the user last looked                |
| Idle         | Nothing new                                        |
| Error        | The last turn failed                               |

- Actions: new session (choose folder, optionally "in a worktree"), rename, fork, archive, delete, mark unread.
- Several sessions can run at once. With one local model they share it; the sidebar shows which are queued.

### Transcript

| Item                         | Rendering                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| User message                 | Text with attached files and images                                                          |
| Assistant text               | Markdown, streamed                                                                           |
| Reasoning                    | Collapsed by default, expandable                                                             |
| Tool call                    | A one-line card: what it is doing, to what, and its state. Expands to full input and output. |
| File edit                    | Inline diff in the card; click to open in the Changes pane                                   |
| Shell command                | Command, live output with ANSI colour, exit status, duration                                 |
| Permission / question / plan | An inline card with its choices (below)                                                      |
| Note, compaction             | A thin divider line with a short label                                                       |

- Auto-scroll follows new output until the user scrolls up; a "jump to latest" control appears then.
- While a long prompt is being read, a progress line shows how far the model has got.
- Any text can be selected and copied; code blocks have a copy button.

### Composer

- Multi-line input. Enter sends, Shift+Enter adds a line.
- `/` opens the command menu; `@` opens fuzzy file search and inserts a mention; images can be pasted or dropped when the model has vision.
- Mode picker (Shift+Tab cycles), model picker, effort picker.
- Context meter: used versus available, with a tooltip breaking it down and offering `/compact`.
- Stop button; Esc also interrupts.
- Messages typed while the agent is working are queued and shown as queued.

### Permission, question and plan cards

- **Permission:** what will run or change (the command, or the diff), why it needs asking, and three actions: allow once, always allow (showing the exact rule that will be saved), deny (with an optional note to the agent). Keyboard shortcuts for each.
- **Question:** the agent's question with its options and a free-text answer.
- **Plan:** the proposed plan rendered as markdown, with approve, approve and accept edits, and keep planning (with feedback).

An unanswered card also marks the session "Needs you" in the sidebar and raises a notification if the window is not focused.

### Panes

| Pane         | Shows                                                                        | Key behaviour                                                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Changes**  | Everything changed in this session's working tree since it started, per file | Side-by-side or inline diff. Select lines and comment; comments are collected and sent to the agent as one message with file and line references. Revert a file or a hunk. |
| **Files**    | The project tree and an editor                                               | Open, edit, save. Files the agent touched are marked. Edits made here are picked up by the agent's stale-file check.                                                       |
| **Terminal** | Real shell tabs in the session's directory                                   | Belongs to the user: the agent does not type here. Tabs persist while the session is open. Selected output can be sent to the composer.                                    |
| **Plan**     | The current or last plan document                                            | Read-only view of what was approved                                                                                                                                        |
| **Tasks**    | The agent's task list and background commands                                | Live status; view output; stop a background command                                                                                                                        |

### Worktree per session

Optional at session creation, for git projects:

1. Create `.dawg/worktrees/<name>` on a new branch `dawg/<name>` from the chosen base.
2. Copy files listed in `.worktreeinclude` (untracked files a checkout needs, such as local env files).
3. Run the session with that worktree as its working directory.
4. When the session is archived and the worktree is clean and merged, remove it. Otherwise keep it and say so.

The Changes pane then shows the branch's diff against its base.

### Notifications and dock

- A macOS notification when a session needs the user or finishes while the window is not focused. Clicking it opens that session.
- A dock badge counting sessions that need the user.
- Both can be turned off.

### Settings

| Page        | Controls                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Models      | From Phase 1: running model and memory, idle unload, installed and available models, endpoints |
| Permissions | Default mode; view and edit allow / ask / deny rules per scope                                 |
| General     | Appearance, how tool calls open, notifications, default worktree behaviour                     |
| Shortcuts   | View the keyboard map                                                                          |

### Keyboard

Every action is reachable from the keyboard. A command palette (Cmd+K) lists all actions and sessions. Defaults follow Claude Code's documented conventions where one exists (Shift+Tab for mode, Esc to interrupt, `/` and `@` in the composer).

### Accessibility and performance

- Full keyboard navigation, visible focus, VoiceOver labels on controls and status marks, respect for reduced-motion and contrast settings.
- Budgets: window visible within 2 seconds of launch; streaming text updates batched to one render per frame; smooth scrolling in a transcript of 5,000 items; a 5,000-line diff opens without freezing the window.

### Security

As in the shared baseline, plus:

- Links in model output open in the system browser, after showing the full URL.
- The renderer never reads or writes files directly. File and git operations for the panes go through validated main-process calls limited to the session's directories.
- Terminal sessions are created only by explicit user action.

## Work breakdown

1. Engine host process and the renderer's message-port client; event reducer and store.
2. Mock engine that replays recorded sessions.
3. Layout shell: sidebar, transcript area, dock, resizing.
4. Transcript items and streaming markdown.
5. Composer: input, commands, mentions, pickers, context meter.
6. Permission, question and plan cards.
7. Sidebar: grouping, statuses, session actions.
8. Changes pane with comments; Files pane.
9. Terminal pane.
10. Plan and Tasks panes.
11. Worktree sessions.
12. Notifications, settings pages, command palette, shortcuts.
13. Accessibility pass and performance pass.

## Testing

| Layer       | What                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | The event reducer against recorded event streams, including out-of-order and replayed events                                                                        |
| Component   | Each transcript item, card and pane in isolation, in light and dark                                                                                                 |
| End-to-end  | Playwright driving the packaged app with the mock model server: a full task with edits, a permission prompt, an interrupt, resume after restart, a worktree session |
| Performance | Scripted long session and large diff, asserting the budgets above                                                                                                   |
| Manual      | A day of real work on a real project, with a written list of friction points                                                                                        |

## Done when

- A full working day on a real project is done without leaving the app for a terminal or editor.
- Every protocol event has a visible representation, and every request is reachable from the UI.
- Quitting mid-turn and relaunching restores every session, its transcript and its pending prompts.
- The end-to-end suite passes in CI, and the performance budgets hold.
- Two sessions can run at once in separate worktrees without interfering.

## Open questions

- Whether several windows are needed at launch, or one window with multiple sessions is enough.
- How much of the Files pane editor to build before people simply open their own editor. An "open in editor" action may cover most of the need.
- Fonts. The mockup uses Geist and Geist Mono, which are under the SIL Open Font License, outside the dependency licence rule in PLAN.md section 12. Either use the macOS system fonts (SF Pro and SF Mono, nothing to bundle) or allow OFL for fonts. Default: the system fonts.
