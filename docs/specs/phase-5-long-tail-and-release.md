# Phase 5 — Long tail and release

_Draft spec. Roadmap: [PLAN.md](../../PLAN.md) section 9. Shared conventions: [README](README.md)._

## Outcome

Two things. First, a download anyone can install: signed, notarized, and able to update itself. Second, the remaining Claude Code features, built in order of how much people use them.

The two halves are independent. **Release engineering does not wait for the feature list**: it can start as soon as Phase 3 produces an app worth installing, and the first public build can ship with whatever features exist.

## Scope

**In**

- Release: packaging, signing, notarization, auto-update, distribution, diagnostics, documentation.
- Features: plugins and marketplaces, output styles, status line, keybindings, notebook editing, LSP diagnostics, scheduled and looping tasks, monitors, multi-agent workflows, browser preview pane, split view, PR and CI status, auto mode, the MLX engine pack, an ACP adapter, and a library API.

**Out**

- Anything that needs Anthropic's cloud (PLAN.md section 8).
- Windows and Linux builds.
- Mac App Store distribution. The app needs to spawn processes and read arbitrary folders, which the App Store sandbox does not allow.

## Depends on

- Release: Phase 3. An Apple Developer Program membership.
- Features: Phases 2–4, each noted below.

## Part A — Release engineering

### Packaging

| Item               | Choice                                                                  |
| ------------------ | ----------------------------------------------------------------------- |
| Tool               | electron-builder                                                        |
| Primary artefact   | Apple Silicon `.dmg`, plus a `.zip` for the updater                     |
| Secondary artefact | Intel `.dmg`, best-effort: it can only attach to a remote endpoint      |
| Bundled binaries   | `llama-server` and its libraries, ripgrep, the terminal's native module |
| Not bundled        | Models. They are downloaded on first run.                               |
| Versioning         | Semantic versions; the protocol version is separate                     |

### Signing and notarization

1. Sign every nested executable and library with the Developer ID certificate, hardened runtime on, innermost first: the runtime binaries, ripgrep, native modules, Electron's helpers, then the app.
2. Entitlements are the minimum Electron needs (JIT for the JavaScript engine). Bundled binaries are signed by us, so library validation stays on.
3. Submit to Apple's notary service with `notarytool`, wait for the result, and staple the ticket to the app and the disk image.
4. Verify in CI with Gatekeeper's assessment tool, and by launching the app on a clean runner.

The sandbox for shell commands (Phase 4) and the bundled runtime are re-tested in the signed build, because hardened runtime changes what child processes may do.

### Auto-update

- electron-updater reading from GitHub Releases.
- Checks at launch and daily. Downloads in the background, verifies the signature, and applies on the next quit. Never interrupts a running session.
- Two channels: stable and beta.
- The update server is only ever told the current version and channel.

### Release pipeline

A tag starts a workflow that builds, signs, notarizes, runs the end-to-end suite against the signed app, and drafts a release with the artefacts and generated notes. A person publishes the draft. Signing credentials live in CI secrets and are available only to that workflow on protected tags.

### Distribution

- GitHub Releases as the source of truth.
- A Homebrew cask in our own tap, updated by the release workflow.
- A README with install steps and the not-affiliated statement.

### Diagnostics

- Logs are local, rotated, and redact secrets and file contents by default.
- "Export diagnostics" builds a zip the user can inspect and attach to an issue: logs, hardware profile, app and runtime versions, runtime settings. No transcripts unless the user ticks a box.
- Crash reports are saved locally. Nothing is uploaded automatically.

### Licences and documents

- A generated third-party notices file in the app, covering every bundled dependency and binary.
- Each model's licence is shown before download (already in Phase 1).
- A user guide, a compatibility matrix against Claude Code's features, a contributing guide, and a security policy with a private reporting address.

### Done when (release)

- A fresh Mac downloads the disk image, opens the app with no Gatekeeper warning, and completes the Phase 1 one-click flow.
- A build from the previous version updates itself to the new one and keeps its sessions and settings.
- The whole pipeline runs from a tag with no manual step except publishing.

## Part B — Features

Listed in build order. Each gets its own short design note when work starts; what follows is the shape and the main decision in each.

### Plugins and marketplaces

_Needs Phase 4._ A plugin is a folder with a manifest that bundles skills, commands, agents, hooks and MCP servers, all of which already work by then.

- Read the documented manifest and component folders. Set the documented plugin-root variable for hooks and servers.
- Install from a local path or a git URL; enable and disable per user or per project; list and update.
- Marketplaces are catalogs of plugins in a git repo. The file format was not confirmed in our research and must be read from the docs first.
- A plugin is third-party code. Installing shows what it contains, and its hooks and servers go through the same consent as project-supplied ones.

### Output styles, status line, keybindings

- **Output styles:** markdown files that adjust the system prompt, in the documented locations, chosen with `/output-style`. Changing style changes the prompt prefix, so it takes effect at the next session or compaction.
- **Status line:** a user command that receives session JSON on stdin and prints one line, shown in the app's footer and the CLI. Run on a debounce, with a timeout.
- **Keybindings:** a user file mapping actions to keys, reloaded when it changes, with conflicts reported.

### Notebook editing and LSP diagnostics

- **NotebookEdit:** replace, insert or delete a cell by id in `.ipynb` files; `Read` renders notebooks cell by cell.
- **LSP:** start language servers per project on demand, and after each edit attach new diagnostics for the changed file to the tool result. Go-to-definition and find-references are exposed as a tool. Servers are found on the user's machine or supplied by plugins; none are bundled at first.

### Scheduled tasks, loops and monitors

_Local only._

- **Scheduled prompts** inside a session, in cron form, with a cap on how many and an expiry, restored when the session resumes.
- **`/loop`** re-runs a prompt on an interval, or self-paced with the model choosing the next delay.
- **Monitor:** a background script whose output lines arrive in the session as events, with a deadline.
- All of them only run while the app is open. The UI says so and shows what is scheduled in the Tasks pane.

### Workflows

Deterministic multi-agent scripts: plain JavaScript calling `agent()`, `parallel()`, `pipeline()` and `phase()`, run in an isolated interpreter with no filesystem or network access of its own. The script only orchestrates; agents do the work under normal permissions. Concurrency is bounded by the available cache slots, so on one machine a wide fan-out mostly queues. Progress shows per phase in the Tasks pane, and a run can be resumed from its recorded results.

### Browser preview, split view, PR status

- **Preview pane:** an isolated web view for the project's dev server, with detection of the port a command started listening on, reload, and console output the user can send to the agent.
- **Split view:** two sessions side by side in one window.
- **PR and CI:** when a session's branch has a pull request, show its checks and review state through the `gh` command-line tool, and offer to hand a failing check's log to the agent. Nothing is pushed or merged without an explicit action.

### Auto mode

A permission mode where a classifier decides whether each action is safe to run without asking.

- The classifier is a call to a local model with the action, the recent conversation and a fixed rubric, returning allow or ask. It never returns deny on its own; uncertain means ask.
- Deny rules, protected paths and the sandbox still apply, and auto mode requires the sandbox to be on.
- A local classifier is weaker than a hosted one. It ships labelled experimental, with its accuracy on a labelled set of safe and unsafe actions published alongside it.

### MLX engine pack

An optional download that runs models through Apple's MLX for faster generation.

- Delivered as a separate signed bundle (a self-contained Python environment and server), installed from settings, so the base app stays small.
- It presents the same `Endpoint` shape as the bundled runtime. Catalog entries gain an optional MLX source alongside the GGUF one.
- The choice of MLX server is made then, on three tests: tool-call reliability on our suite, prompt-cache behaviour across turns and across restarts, and measured speed on the reference Mac.
- It becomes the default for a model only if it beats the bundled runtime on that model in our own measurements.

### ACP adapter and library API

- **`dawg acp`:** speaks the Agent Client Protocol on stdio, translating to and from our protocol, so editors that support it can drive the engine. Features with no ACP equivalent are omitted there.
- **Library:** `@dawg/sdk`, a thin package that starts an engine and returns an async stream of events for a prompt, with a callback for permission decisions and a way to define in-process tools. It is the headless CLI's internals with a stable surface.

### Done when (features)

Each feature is done when it has tests, documentation, a row in the compatibility matrix, and no regression on the eval suite. There is no single finish line for this half.

## Work breakdown

**Release (in order)**

1. electron-builder configuration and unsigned local packaging.
2. Signing of nested binaries; notarization; CI verification.
3. Auto-update with a beta channel; update test from the previous version.
4. Release workflow from a tag; Homebrew cask.
5. Diagnostics export; notices file; user-facing documents.

**Features (suggested order)**

1. Plugins and marketplaces.
2. Output styles, status line, keybindings.
3. Browser preview pane and split view.
4. PR and CI status.
5. LSP diagnostics; notebook editing.
6. Scheduled tasks, loops, monitors.
7. MLX engine pack.
8. ACP adapter; library API.
9. Workflows.
10. Auto mode.

## Testing

| Area       | What                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release    | The signed build passes Gatekeeper and the end-to-end suite on a clean runner; an update from the previous release preserves data; the bundled runtime and sandbox work under hardened runtime |
| Plugins    | Fixture plugins covering each component type; install, disable, update, remove; consent enforced                                                                                               |
| Scheduling | Fake-clock tests for cron, expiry and resume                                                                                                                                                   |
| Workflows  | Scripts run against the scripted engine; isolation tests proving a script cannot reach files or the network                                                                                    |
| Auto mode  | A labelled set of safe and unsafe actions, with the miss rate tracked release to release                                                                                                       |
| MLX pack   | The same supervisor and eval tests as the bundled runtime                                                                                                                                      |

## Open questions

- Whether to ship a universal build instead of two artefacts.
- How to deliver and update the MLX pack: its own release artefact, or a download managed like models.
- Whether workflows are worth their complexity on single-machine hardware, where parallelism is limited by memory.
- A public roadmap and how outside contributions are reviewed, once the repo has users.
