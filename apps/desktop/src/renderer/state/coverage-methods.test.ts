/**
 * Phase 3's "Done when": every request is reachable from the UI.
 *
 * The table below has one entry per method in the protocol's registry (`METHOD_NAMES`), so a
 * method added to the protocol without one fails here. An entry is either internal (the window
 * sends it on its own, with the reason) or names how a person reaches it:
 * - `wire`: the store actions that send it. Each runs against a real runtime and the fake engine
 *   (the protocol server over a message port), which must receive the method.
 * - `registry`: actions in the command palette and keymap (app/commands/registry.ts). Each runs,
 *   and must call one of the wire actions (or open the palette's own step that does).
 * - `components`: the components whose controls call one of the wire actions. Checked in their
 *   source; the component tests drive the clicks (SidebarContainer.test.tsx, Composer.test.tsx
 *   and ComposerContainer.test.tsx, cards.test.tsx, panes/tasks/tasks.test.tsx, the palette's
 *   tests, NewSessionDialog.test.tsx).
 */
import {
  type CompatItem,
  METHOD_NAMES,
  type MethodName,
  type PermissionResponse,
  type SessionSnapshot,
} from "@dawg/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { availability, commandById, dynamicCommands } from "../app/commands/registry.ts";
import { sessionsStore } from "../app/commands/testing.ts";
import type { CommandContext, PaletteUi } from "../app/commands/types.ts";
import { createFakeBridge, type FakeBridge } from "./__fixtures__/fake-bridge.ts";
import { FakeEngine } from "./__fixtures__/fake-engine.ts";
import { makeBackgroundTask, makeSubagent, PROJECT } from "./__fixtures__/streams.ts";
import { type AppStoreApi, createAppStore } from "./store.ts";
import type { AppActions, UiState } from "./types.ts";

/** The renderer's sources as text, by path from here ("../app/SessionArea.tsx"). */
const SOURCES = import.meta.glob<string>(["../**/*.ts", "../**/*.tsx", "!../**/*.test.*"], {
  eager: true,
  query: "?raw",
  import: "default",
});
const ID = "s1";

type ActionName = keyof AppActions;

interface WirePath {
  action: ActionName;
  /** Puts the fake engine in the state the action needs (a running turn, a pending card). */
  setup?: (engine: FakeEngine) => void;
  /** Calls the action on the session `s1`, which is open and selected. */
  call: (actions: AppActions) => Promise<unknown>;
}

interface RegistryPath {
  /** A command id; "model:*" means the first dynamic command whose id starts with "model:". */
  id: string;
  /** The wire action it calls, or the palette step it opens (which calls one, see `components`). */
  calls: ActionName | "palette.rename" | "palette.confirmDelete";
  /** Snapshot fields of the selected session that make the command available. */
  snapshot?: Partial<Omit<SessionSnapshot, "session">>;
  /** UI state that makes it available (a held message). */
  ui?: Partial<UiState>;
}

interface ComponentPath {
  /** Under src/renderer. */
  file: string;
  action: ActionName;
  /** How the file uses it, when not as a call (`actions.<action>(`): a pattern. */
  uses?: string;
}

type Reach =
  | { internal: string }
  | { wire: WirePath[]; registry?: RegistryPath[]; components?: ComponentPath[] };

// --- Engine states the actions need --------------------------------------------------------------

function runningTurn(engine: FakeEngine): void {
  engine.emit(ID, "session.status", { status: "working", waitingOn: null, message: null });
  engine.emit(ID, "turn.started", {
    turnId: "t1",
    prompt: { content: [{ type: "text", text: "Fix the split" }], mentions: [] },
    command: null,
  });
}

function pendingPermission(engine: FakeEngine): void {
  runningTurn(engine);
  engine.emit(ID, "permission.requested", {
    turnId: "t1",
    request: {
      requestId: "p1",
      toolCallId: "c1",
      toolName: "Bash",
      input: { command: "uv run pytest -q" },
      title: "Run a shell command",
      reason: "No rule allows this command",
      suggestions: [],
    },
  });
  engine.emit(ID, "session.status", { status: "waiting", waitingOn: "permission", message: null });
}

function pendingQuestion(engine: FakeEngine): void {
  runningTurn(engine);
  engine.emit(ID, "question.asked", {
    turnId: "t1",
    requestId: "q1",
    toolCallId: "c1",
    questions: [{ question: "Which file?", options: [{ label: "a.py" }], multiSelect: false }],
  });
  engine.emit(ID, "session.status", { status: "waiting", waitingOn: "question", message: null });
}

function pendingPlan(engine: FakeEngine): void {
  runningTurn(engine);
  engine.emit(ID, "plan.proposed", {
    turnId: "t1",
    requestId: "r1",
    toolCallId: "c1",
    plan: "# Plan",
    planPath: null,
    modeBeforePlan: "default",
  });
  engine.emit(ID, "session.status", { status: "waiting", waitingOn: "plan", message: null });
}

function pendingElicitation(engine: FakeEngine): void {
  runningTurn(engine);
  engine.emit(ID, "elicitation.requested", {
    turnId: "t1",
    requestId: "e1",
    toolCallId: "c1",
    server: "tracker",
    message: "Which project?",
    mode: "form",
    fields: [
      {
        name: "project",
        type: "string",
        title: null,
        description: null,
        required: true,
        format: null,
        minLength: null,
        maxLength: null,
        default: null,
      },
    ],
    url: null,
  });
  engine.emit(ID, "session.status", {
    status: "waiting",
    waitingOn: "elicitation",
    message: null,
  });
}

/** A turn that has ended: the session has a checkpoint to rewind to. */
function turnDone(engine: FakeEngine): void {
  runningTurn(engine);
  engine.emit(ID, "turn.finished", {
    turnId: "t1",
    stopReason: "completed",
    finalText: "Done.",
    error: null,
    durationMs: 100,
  });
  engine.emit(ID, "session.status", { status: "idle", waitingOn: null, message: null });
}

function runningCommand(engine: FakeEngine): void {
  engine.emit(ID, "background.updated", { task: makeBackgroundTask("bash-1") });
  engine.backgroundOutput(ID, "bash-1", "listening on :3000\n");
}

function runningAgent(engine: FakeEngine): void {
  engine.emit(ID, "subagent.updated", { agent: makeSubagent("agent-1", { background: true }) });
}

/** The project has a hook from its Claude Code settings waiting for the person's consent. */
function codeWaiting(engine: FakeEngine): void {
  const item: CompatItem = {
    kind: "hook",
    name: "PreToolUse on Bash: ./scripts/check-command.sh",
    source: { path: `${PROJECT}/.claude/settings.json`, origin: "claude", scope: "project" },
    status: "needs-approval",
    notes: ["Runs a command from the project's files."],
  };
  engine.overrides["project.inspect"] = (params) => ({
    projectDir: params.projectDir,
    items: [item],
    approval: { hash: "sha256:9f2c", approved: false, items: [item] },
  });
}

const ALLOW_ONCE: PermissionResponse = { behavior: "allow", scope: "once" };
const WORKING = { activeTurnId: "t1" };

// --- The table ---------------------------------------------------------------------------------

const REACH: Record<MethodName, Reach> = {
  initialize: {
    internal: "The connection sends it first on every engine port: at start and after a restart.",
  },
  "session.list": {
    internal: "The connection lists every stored session at each connect to fill the sidebar.",
  },
  "project.inspect": {
    // The trust dialog asks on its own when a project's session is first shown, and when the
    // person asks to review the project's code. Settings → Project setup shows the whole report
    // (and the first-open notice links there).
    wire: [
      { action: "reviewProjectCode", call: async (a) => a.reviewProjectCode(PROJECT) },
      { action: "inspectProject", call: (a) => a.inspectProject(PROJECT) },
    ],
    components: [
      { file: "app/SessionArea.tsx", action: "reviewProjectCode" },
      { file: "settings/SettingsContainer.tsx", action: "reviewProjectCode" },
      { file: "settings/ProjectSetupPageContainer.tsx", action: "inspectProject" },
    ],
  },
  "project.trust": {
    wire: [
      {
        action: "answerTrustReview",
        setup: codeWaiting,
        call: (a) => approveFromDialog(a),
      },
    ],
    components: [{ file: "trust/TrustDialog.tsx", action: "answerTrustReview" }],
  },
  "hooks.list": {
    wire: [{ action: "listHooks", call: (a) => a.listHooks(PROJECT) }],
    components: [
      {
        file: "settings/SettingsContainer.tsx",
        action: "listHooks",
        uses: "listHooks=\\{actions\\.listHooks\\}",
      },
    ],
  },
  "project.skills": {
    wire: [{ action: "listSkills", call: (a) => a.listSkills(PROJECT) }],
    // Settings → Skills and commands lists them for the project the person picks.
    components: [
      {
        file: "settings/SettingsContainer.tsx",
        action: "listSkills",
        uses: "listSkills=\\{actions\\.listSkills\\}",
      },
    ],
  },
  "project.subagents": {
    wire: [{ action: "listSubagents", call: (a) => a.listSubagents(PROJECT) }],
    // Settings → Subagents lists them for the project the person picks.
    components: [
      {
        file: "settings/SettingsContainer.tsx",
        action: "listSubagents",
        uses: "listSubagents=\\{actions\\.listSubagents\\}",
      },
    ],
  },
  "subagent.create": {
    wire: [
      {
        action: "createSubagent",
        call: (a) =>
          a.createSubagent({
            projectDir: PROJECT,
            scope: "user",
            name: "code-reviewer",
            description: "Reviews code",
            prompt: "You review code.",
            tools: null,
            memory: null,
          }),
      },
    ],
    // Settings → Subagents' "New subagent" form writes the file.
    components: [
      {
        file: "settings/SettingsContainer.tsx",
        action: "createSubagent",
        uses: "createSubagent=\\{actions\\.createSubagent\\}",
      },
    ],
  },
  "hooks.setEnabled": {
    wire: [{ action: "setHookEnabled", call: (a) => a.setHookEnabled(PROJECT, "hook:1", false) }],
    components: [
      {
        file: "settings/SettingsContainer.tsx",
        action: "setHookEnabled",
        uses: "setHookEnabled=\\{actions\\.setHookEnabled\\}",
      },
    ],
  },
  "mcp.list": {
    wire: [{ action: "listMcpServers", call: (a) => a.listMcpServers(PROJECT) }],
    // Settings → MCP servers lists them for the project the person picks.
    components: [
      {
        file: "settings/SettingsContainer.tsx",
        action: "listMcpServers",
        uses: "listMcpServers=\\{actions\\.listMcpServers\\}",
      },
    ],
  },
  "mcp.restart": {
    wire: [{ action: "restartMcpServer", call: (a) => a.restartMcpServer(PROJECT, "github") }],
    components: [
      {
        file: "settings/SettingsContainer.tsx",
        action: "restartMcpServer",
        uses: "restartMcpServer=\\{actions\\.restartMcpServer\\}",
      },
    ],
  },
  "mcp.setEnabled": {
    wire: [
      {
        action: "setMcpServerEnabled",
        call: (a) => a.setMcpServerEnabled(PROJECT, "github", false),
      },
    ],
    components: [
      {
        file: "settings/SettingsContainer.tsx",
        action: "setMcpServerEnabled",
        uses: "setMcpServerEnabled=\\{actions\\.setMcpServerEnabled\\}",
      },
    ],
  },
  "mcp.importPreview": {
    wire: [{ action: "previewMcpImport", call: (a) => a.previewMcpImport() }],
    // "Import…" on Settings → MCP servers shows what would be copied first.
    components: [
      {
        file: "settings/SettingsContainer.tsx",
        action: "previewMcpImport",
        uses: "previewMcpImport=\\{actions\\.previewMcpImport\\}",
      },
    ],
  },
  "mcp.import": {
    wire: [{ action: "importMcpServers", call: (a) => a.importMcpServers("sha256:1a2b") }],
    components: [
      {
        file: "settings/SettingsContainer.tsx",
        action: "importMcpServers",
        uses: "importMcpServers=\\{actions\\.importMcpServers\\}",
      },
    ],
  },
  "mcp.signIn": {
    wire: [{ action: "signInMcpServer", call: (a) => a.signInMcpServer(PROJECT, "linear") }],
    // "Sign in" on Settings → MCP servers; the page opens the address it gets in the browser.
    components: [
      {
        file: "settings/SettingsContainer.tsx",
        action: "signInMcpServer",
        uses: "signInMcpServer=\\{actions\\.signInMcpServer\\}",
      },
    ],
  },
  "mcp.signOut": {
    wire: [{ action: "signOutMcpServer", call: (a) => a.signOutMcpServer(PROJECT, "linear") }],
    components: [
      {
        file: "settings/SettingsContainer.tsx",
        action: "signOutMcpServer",
        uses: "signOutMcpServer=\\{actions\\.signOutMcpServer\\}",
      },
    ],
  },
  "mcp.cancelSignIn": {
    wire: [{ action: "cancelMcpSignIn", call: (a) => a.cancelMcpSignIn(PROJECT, "linear") }],
    // Cancel beside "Signing in…".
    components: [
      {
        file: "settings/SettingsContainer.tsx",
        action: "cancelMcpSignIn",
        uses: "cancelMcpSignIn=\\{actions\\.cancelMcpSignIn\\}",
      },
    ],
  },
  "mcp.session": {
    wire: [{ action: "mcpOffer", call: (a) => a.mcpOffer(ID) }],
    // The composer's @ menu offers the session's resources, its / menu the servers' prompts.
    components: [{ file: "composer/ComposerContainer.tsx", action: "mcpOffer" }],
  },
  "session.replay": {
    internal:
      "Opening a session replays its history into the transcript, and a reconnect catches up from the high-water mark.",
  },
  "session.create": {
    wire: [
      {
        action: "newSession",
        call: (a) => a.newSession({ projectDir: PROJECT, worktree: false }),
      },
      { action: "answerNewSessionOffer", call: (a) => newSessionFromDialog(a) },
    ],
    registry: [
      { id: "session.new", calls: "newSession" },
      { id: "session.new-worktree", calls: "newSession" },
      { id: "session.new-in-folder", calls: "newSession" },
    ],
    components: [
      { file: "sidebar/SidebarContainer.tsx", action: "newSession" },
      { file: "app/MainWindow.tsx", action: "newSession" },
      { file: "app/NewSessionDialog.tsx", action: "answerNewSessionOffer" },
    ],
  },
  "session.resume": {
    wire: [
      {
        action: "selectSession",
        setup: (engine) => engine.addSession("stored", { lastActivityAt: 0 }),
        call: async (a) => a.selectSession("stored"),
      },
    ],
    registry: [
      { id: "session.next", calls: "selectSession" },
      { id: "session.previous", calls: "selectSession" },
    ],
    components: [
      { file: "sidebar/SidebarContainer.tsx", action: "selectSession" },
      { file: "app/palette/CommandPalette.tsx", action: "selectSession" },
    ],
  },
  "session.fork": {
    wire: [{ action: "forkSession", call: (a) => a.forkSession(ID) }],
    registry: [{ id: "session.fork", calls: "forkSession" }],
    components: [{ file: "sidebar/SidebarContainer.tsx", action: "forkSession" }],
  },
  "session.rename": {
    wire: [{ action: "renameSession", call: (a) => a.renameSession(ID, "Split evenly") }],
    // The palette asks for the new title, then CommandPalette.tsx renames.
    registry: [{ id: "session.rename", calls: "palette.rename" }],
    components: [
      { file: "sidebar/SidebarContainer.tsx", action: "renameSession" },
      { file: "app/palette/CommandPalette.tsx", action: "renameSession" },
    ],
  },
  "session.archive": {
    wire: [{ action: "archiveSession", call: (a) => a.archiveSession(ID) }],
    registry: [{ id: "session.archive", calls: "archiveSession" }],
    components: [{ file: "sidebar/SidebarContainer.tsx", action: "archiveSession" }],
  },
  "session.delete": {
    wire: [{ action: "deleteSession", call: (a) => a.deleteSession(ID) }],
    // The palette asks first, then CommandPalette.tsx deletes.
    registry: [{ id: "session.delete", calls: "palette.confirmDelete" }],
    components: [
      { file: "sidebar/SidebarContainer.tsx", action: "deleteSession" },
      { file: "app/palette/CommandPalette.tsx", action: "deleteSession" },
    ],
  },
  "session.prompt": {
    wire: [
      { action: "submit", call: (a) => a.submit(ID, "Fix the failing split test") },
      {
        action: "sendQueuedNow",
        call: async (a) => {
          // A message held after a stop, sent with "Send now".
          await sendHeldNow(a);
        },
      },
    ],
    registry: [
      {
        id: "session.send-held",
        calls: "sendQueuedNow",
        ui: { queues: { fix: [{ id: "q1", text: "Then update the changelog", state: "held" }] } },
      },
    ],
    components: [
      { file: "composer/ComposerContainer.tsx", action: "submit" },
      { file: "composer/ComposerContainer.tsx", action: "sendQueuedNow" },
      // Comments on changes go to the agent as one message.
      { file: "panes/changes/index.tsx", action: "submit" },
    ],
  },
  "session.interrupt": {
    wire: [{ action: "interrupt", setup: runningTurn, call: (a) => a.interrupt(ID) }],
    registry: [{ id: "session.stop", calls: "interrupt", snapshot: WORKING }],
    components: [{ file: "composer/ComposerContainer.tsx", action: "interrupt" }],
  },
  "session.setMode": {
    wire: [
      { action: "setMode", call: (a) => a.setMode(ID, "plan") },
      { action: "cycleMode", call: (a) => a.cycleMode(ID) },
    ],
    registry: [
      { id: "mode.cycle", calls: "cycleMode" },
      { id: "mode.plan", calls: "setMode" },
    ],
    components: [
      { file: "composer/ComposerContainer.tsx", action: "setMode" },
      { file: "composer/ComposerContainer.tsx", action: "cycleMode" },
    ],
  },
  "session.setModel": {
    wire: [{ action: "setModel", call: (a) => a.setModel(ID, "another-model") }],
    registry: [{ id: "model:*", calls: "setModel" }],
    components: [{ file: "composer/ComposerContainer.tsx", action: "setModel" }],
  },
  "session.setEffort": {
    wire: [{ action: "setEffort", call: (a) => a.setEffort(ID, "high") }],
    registry: [{ id: "effort:*", calls: "setEffort" }],
    components: [{ file: "composer/ComposerContainer.tsx", action: "setEffort" }],
  },
  "session.command": {
    wire: [
      { action: "compact", call: (a) => a.compact(ID) },
      // "/help" typed in the composer: a command the session offers.
      { action: "submit", call: (a) => a.submit(ID, "/help") },
    ],
    registry: [{ id: "session.compact", calls: "compact" }],
    components: [
      { file: "composer/ComposerContainer.tsx", action: "compact" },
      { file: "composer/ComposerContainer.tsx", action: "submit" },
    ],
  },
  "session.checkpoints": {
    // The rewind dialog lists them: Esc twice in the composer, `/rewind`, or the palette.
    wire: [{ action: "openRewind", setup: turnDone, call: (a) => a.openRewind(ID) }],
    registry: [{ id: "session.rewind", calls: "openRewind" }],
    components: [{ file: "composer/ComposerContainer.tsx", action: "openRewind" }],
  },
  "session.rewind": {
    wire: [{ action: "rewind", setup: turnDone, call: (a) => rewindFromDialog(a) }],
    // The dialog's actions: restore files and conversation, conversation, files, summarise.
    components: [{ file: "rewind/RewindDialog.tsx", action: "rewind" }],
  },
  "background.output": {
    wire: [
      {
        action: "readBackgroundOutput",
        setup: runningCommand,
        call: (a) => a.readBackgroundOutput(ID, "bash-1", 0),
      },
    ],
    // The pane hands the action to each command's row, which reads as the person opens it.
    components: [
      {
        file: "panes/tasks/index.tsx",
        action: "readBackgroundOutput",
        uses: "read=\\{actions\\.readBackgroundOutput\\}",
      },
    ],
  },
  "background.stop": {
    wire: [
      {
        action: "stopBackground",
        setup: runningCommand,
        call: (a) => a.stopBackground(ID, "bash-1"),
      },
    ],
    components: [{ file: "panes/tasks/index.tsx", action: "stopBackground" }],
  },
  "subagent.stop": {
    wire: [
      {
        action: "stopSubagent",
        setup: runningAgent,
        call: (a) => a.stopSubagent(ID, "agent-1"),
      },
    ],
    // A background agent's row in the Tasks pane has Stop.
    components: [{ file: "panes/tasks/index.tsx", action: "stopSubagent" }],
  },
  "permission.respond": {
    wire: [
      {
        action: "respondPermission",
        setup: pendingPermission,
        call: (a) => a.respondPermission(ID, "p1", ALLOW_ONCE),
      },
      // Text sent while the card is open denies the command with that note.
      { action: "submit", setup: pendingPermission, call: (a) => a.submit(ID, "Use make") },
    ],
    components: [
      { file: "app/SessionArea.tsx", action: "respondPermission" },
      { file: "composer/ComposerContainer.tsx", action: "submit" },
    ],
  },
  "question.respond": {
    wire: [
      {
        action: "respondQuestion",
        setup: pendingQuestion,
        call: (a) =>
          a.respondQuestion(ID, "q1", {
            outcome: "answered",
            answers: [{ question: "Which file?", selected: ["a.py"] }],
          }),
      },
      { action: "submit", setup: pendingQuestion, call: (a) => a.submit(ID, "b.py") },
    ],
    components: [
      { file: "app/SessionArea.tsx", action: "respondQuestion" },
      { file: "composer/ComposerContainer.tsx", action: "submit" },
    ],
  },
  "plan.respond": {
    wire: [
      {
        action: "respondPlan",
        setup: pendingPlan,
        call: (a) => a.respondPlan(ID, "r1", { decision: "approve" }),
      },
      { action: "submit", setup: pendingPlan, call: (a) => a.submit(ID, "Keep it smaller") },
    ],
    components: [
      { file: "app/SessionArea.tsx", action: "respondPlan" },
      { file: "composer/ComposerContainer.tsx", action: "submit" },
    ],
  },
  "elicitation.respond": {
    wire: [
      {
        action: "respondElicitation",
        setup: pendingElicitation,
        call: (a) =>
          a.respondElicitation(ID, "e1", { action: "accept", content: { project: "tally" } }),
      },
      // A message typed while the form waits declines it, and goes on as a queued message.
      { action: "submit", setup: pendingElicitation, call: (a) => a.submit(ID, "Not that one") },
    ],
    components: [
      { file: "app/SessionArea.tsx", action: "respondElicitation" },
      { file: "composer/ComposerContainer.tsx", action: "submit" },
    ],
  },
};

// --- Runtime harness -----------------------------------------------------------------------------

interface Harness {
  engine: FakeEngine;
  bridge: FakeBridge;
  store: AppStoreApi;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const { store, bridge } of harnesses.splice(0)) {
    store.getState().actions.stop();
    bridge.close();
  }
});

/** A runtime on the fake engine with `s1` open and selected, after `setup`. */
async function started(setup?: (engine: FakeEngine) => void): Promise<Harness> {
  const engine = new FakeEngine();
  engine.addSession(ID);
  setup?.(engine);
  const bridge = createFakeBridge({
    engine,
    windowState: { selectedSessionId: ID },
    repos: { [PROJECT]: { current: "main", branches: ["main"] } },
  });
  const store = createAppStore({ bridge });
  const harness = { engine, bridge, store };
  harnesses.push(harness);
  await store.getState().actions.start();
  await vi.waitFor(() => expect(store.getState().sessions[ID]?.loaded).toBe(true));
  return harness;
}

/** The harness of the wire test running now, for the calls that drive it in several steps. */
let currentStore: AppStoreApi | null = null;
let currentEngine: FakeEngine | null = null;

/** The new-session dialog, answered with "in the project folder". */
async function newSessionFromDialog(actions: AppActions): Promise<unknown> {
  const made = actions.newSession({ projectDir: PROJECT, ask: true });
  await vi.waitFor(() => expect(currentStore?.getState().newSessionOffer).not.toBeNull());
  await actions.answerNewSessionOffer({ worktree: null });
  return made;
}

/** Opens the trust dialog for the project and approves what it lists. */
async function approveFromDialog(actions: AppActions): Promise<void> {
  const store = currentStore;
  if (!store) throw new Error("no harness");
  actions.reviewProjectCode(PROJECT);
  await vi.waitFor(() => expect(store.getState().trustReview?.phase).toBe("ready"));
  await actions.answerTrustReview(true);
}

/** Opens the rewind dialog and goes back to before the first prompt, files and conversation. */
async function rewindFromDialog(actions: AppActions): Promise<void> {
  const store = currentStore;
  if (!store) throw new Error("no harness");
  await actions.openRewind(ID);
  await vi.waitFor(() => expect(store.getState().rewind?.phase).toBe("ready"));
  const checkpoint = store.getState().rewind?.checkpoints[0];
  if (!checkpoint) throw new Error("no checkpoint listed");
  await actions.rewind(checkpoint.id, "both");
}

/** Queues a message behind a running turn, stops the turn (the message is held), then sends it. */
async function sendHeldNow(actions: AppActions): Promise<void> {
  const store = currentStore;
  const engine = currentEngine;
  if (!store || !engine) throw new Error("no harness");
  runningTurn(engine);
  await vi.waitFor(() => expect(store.getState().sessions[ID]?.activeTurnId).toBe("t1"));
  await actions.submit(ID, "Then update the changelog");
  await actions.interrupt(ID);
  engine.emit(ID, "turn.finished", {
    turnId: "t1",
    stopReason: "interrupted",
    finalText: null,
    error: null,
    durationMs: 100,
  });
  engine.emit(ID, "session.status", { status: "idle", waitingOn: null, message: null });
  await vi.waitFor(() => expect(store.getState().sessions[ID]?.activeTurnId).toBeNull());
  const held = store.getState().ui.queues[ID]?.find((message) => message.state === "held");
  if (!held) throw new Error("the message was not held");
  await actions.sendQueuedNow(ID, held.id);
}

// --- Registry harness ----------------------------------------------------------------------------

function registryRun(entry: RegistryPath) {
  const test = sessionsStore({
    ...(entry.snapshot ? { open: { fix: entry.snapshot } } : {}),
    patch: (state) => ({ ui: { ...state.ui, ...entry.ui } }),
  });
  const state = test.store.getState();
  const palette: PaletteUi = {
    open: vi.fn(),
    close: vi.fn(),
    toggle: vi.fn(),
    rename: vi.fn(),
    confirmDelete: vi.fn(),
    // Nothing is open: the task runs at once.
    whenClosed: (task) => task(),
  };
  const command = entry.id.endsWith("*")
    ? dynamicCommands(state).find((candidate) => candidate.id.startsWith(entry.id.slice(0, -1)))
    : commandById(entry.id);
  if (!command) throw new Error(`No command ${entry.id} in the registry`);
  const context: CommandContext = {
    state,
    actions: state.actions,
    store: test.store,
    os: "darwin",
    palette,
  };
  return { test, command, context, palette };
}

// --- Tests -------------------------------------------------------------------------------------

describe("every request is reachable from the UI", () => {
  it("covers exactly the protocol's methods", () => {
    expect(Object.keys(REACH).sort()).toEqual([...METHOD_NAMES].sort());
    for (const [method, reach] of Object.entries(REACH)) {
      if ("internal" in reach) continue;
      // A person reaches it from the palette or a control, not only from code.
      const ways = (reach.registry?.length ?? 0) + (reach.components?.length ?? 0);
      expect(ways, method).toBeGreaterThan(0);
    }
  });

  it("sends the internal methods by itself when it starts and opens a session", async () => {
    const { engine } = await started();
    expect(engine.callsOf("initialize")).toHaveLength(1);
    expect(engine.callsOf("session.list").length).toBeGreaterThan(0);
    expect(engine.callsOf("session.replay")).toContainEqual(
      expect.objectContaining({ sessionId: ID }),
    );
  });

  const wires = Object.entries(REACH).flatMap(([method, reach]) =>
    "internal" in reach ? [] : reach.wire.map((wire) => ({ method, wire })),
  );
  it.each(wires)("$method is sent by actions.$wire.action", async ({ method, wire }) => {
    const harness = await started(wire.setup);
    currentStore = harness.store;
    currentEngine = harness.engine;
    try {
      const before = harness.engine.callsOf(method).length;
      await wire.call(harness.store.getState().actions);
      await vi.waitFor(() => expect(harness.engine.callsOf(method).length).toBeGreaterThan(before));
      // Nothing went wrong on the way.
      expect(harness.store.getState().notices.filter((notice) => notice.tone === "error")).toEqual(
        [],
      );
    } finally {
      currentStore = null;
      currentEngine = null;
    }
  });

  const commands = Object.entries(REACH).flatMap(([method, reach]) =>
    "internal" in reach ? [] : (reach.registry ?? []).map((entry) => ({ method, entry, reach })),
  );
  it.each(commands)("$method: the palette's $entry.id calls $entry.calls", ({ entry, reach }) => {
    if ("internal" in reach) return;
    const { test, command, context, palette } = registryRun(entry);
    expect(availability(command, context.state)).toBe(true);
    command.run?.(context);
    if (entry.calls === "palette.rename") {
      expect(palette.rename).toHaveBeenCalledWith("fix");
    } else if (entry.calls === "palette.confirmDelete") {
      expect(palette.confirmDelete).toHaveBeenCalledWith("fix");
    } else {
      expect(reach.wire.map((wire) => wire.action)).toContain(entry.calls);
      expect(test.actions[entry.calls]).toHaveBeenCalled();
    }
  });

  const controls = Object.entries(REACH).flatMap(([method, reach]) =>
    "internal" in reach ? [] : (reach.components ?? []).map((entry) => ({ method, entry, reach })),
  );
  it.each(controls)("$method: $entry.file calls actions.$entry.action", ({ entry, reach }) => {
    if ("internal" in reach) return;
    expect(reach.wire.map((wire) => wire.action)).toContain(entry.action);
    const source = SOURCES[`../${entry.file}`];
    expect(source, entry.file).toBeDefined();
    expect(source).toMatch(new RegExp(entry.uses ?? `\\.${entry.action}\\(`));
  });
});
