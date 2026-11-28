/**
 * Phase 3's "Done when": every protocol event has a visible representation.
 *
 * The table below has one entry per event in the protocol's registry (`EVENT_NAMES`), so an
 * event added to the protocol without one fails here. Each entry is one or more scenarios: a
 * session in some state, the event, and what follows it. The check is counterfactual: the view
 * models the window renders (sidebar, title bar, transcript, composer, panes, model footer) are
 * built once with the event and once without it, and the view the entry names must differ. The
 * reducer must not ignore the event either; an event it may ignore would need its reason in
 * `IGNORED`, which is empty.
 */
import { EVENT_NAMES, type EventName, type SessionSnapshot } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import { MOCK_MODELS } from "../../shared/mock-models.ts";
import {
  createStream,
  HOME,
  makeBackgroundTask,
  makeSnapshot,
  makeSubagent,
  makeSummary,
  makeUsage,
  PROJECT,
  type Stream,
  T0,
} from "./__fixtures__/streams.ts";
import { emptyEngineSlice, reduceAll } from "./reducer.ts";
import {
  selectComposer,
  selectModelFooter,
  selectPlanPane,
  selectSidebar,
  selectTasksPane,
  selectTitleBar,
  selectTranscript,
} from "./selectors.ts";
import { initialAppState } from "./store.ts";
import type { AppActions, AppStore, EngineSlice, ReducerInput } from "./types.ts";

const ID = "s1";
const NOW = T0 + 60_000;

/** What the window renders, by view model. */
const VIEWS = {
  sidebar: (state: AppStore) => selectSidebar(state, NOW),
  titleBar: (state: AppStore) => selectTitleBar(state),
  transcript: (state: AppStore) => selectTranscript(state, ID),
  composer: (state: AppStore) => selectComposer(state, ID),
  tasksPane: (state: AppStore) => selectTasksPane(state, ID),
  planPane: (state: AppStore) => selectPlanPane(state, ID),
  modelFooter: (state: AppStore) => selectModelFooter(state),
} as const;
type View = keyof typeof VIEWS;

interface Scenario {
  /** Where the event shows, and what a person sees there. */
  shows: { view: View; what: string };
  /** The session's snapshot when it opened. */
  snapshot?: Partial<Omit<SessionSnapshot, "session">>;
  /** Events before the one under test. */
  before?: (stream: Stream) => void;
  /** Emits the event under test (one event). */
  event: (stream: Stream) => void;
  /** Events after it, applied in both runs. */
  after?: (stream: Stream) => void;
  /** Apply every event as one replay page without deltas (as when a stored session opens). */
  replay?: boolean;
}

/** Events the reducer may ignore, with the reason. Nothing is ignored today. */
const IGNORED: Partial<Record<EventName, string>> = {};

// --- Building blocks ---------------------------------------------------------------------------

const working = (s: Stream) =>
  s.emit("session.status", { status: "working", waitingOn: null, message: null });

const turnStarted = (s: Stream, text = "Fix the failing split test") =>
  s.emit("turn.started", {
    turnId: "t1",
    prompt: { content: [{ type: "text", text }], mentions: [] },
    command: null,
  });

const running = (s: Stream) => {
  working(s);
  turnStarted(s);
};

const messageStarted = (s: Stream) => s.emit("message.started", { turnId: "t1", messageId: "m1" });

const replyWithCall = (s: Stream, toolName: string) => {
  messageStarted(s);
  s.emit("message.finished", {
    turnId: "t1",
    messageId: "m1",
    text: "",
    reasoning: null,
    toolCalls: [{ toolCallId: "c1", toolName }],
  });
};

const bashStarted = (s: Stream) => {
  running(s);
  replyWithCall(s, "Bash");
  s.emit("tool.started", {
    turnId: "t1",
    messageId: "m1",
    toolCallId: "c1",
    toolName: "Bash",
    input: { command: "uv run pytest -q" },
  });
};

const permissionRequested = (s: Stream) =>
  s.emit("permission.requested", {
    turnId: "t1",
    request: {
      requestId: "p1",
      toolCallId: "c1",
      toolName: "Bash",
      input: { command: "uv run pytest -q" },
      title: "Run a shell command",
      reason: "No rule allows this command",
      suggestions: ["Bash(uv run pytest *)"],
    },
  });

const compactionStarted = (s: Stream) =>
  s.emit("compaction.started", {
    compactionId: "k1",
    trigger: "manual",
    turnId: null,
    contextUsed: 140_000,
    contextWindow: 204_800,
    focus: null,
  });

// --- The table ---------------------------------------------------------------------------------

const COVERAGE: Record<EventName, Scenario[]> = {
  "session.status": [
    {
      shows: { view: "sidebar", what: "the row's status mark: working" },
      event: working,
    },
    {
      shows: { view: "modelFooter", what: "“Ready · 1 queued”: the turn waits for the model" },
      event: (s) =>
        s.emit("session.status", {
          status: "working",
          waitingOn: null,
          message: "Waiting for the model",
          queuePosition: 1,
        }),
    },
  ],
  "session.deleted": [
    {
      shows: { view: "sidebar", what: "the session's row leaves the sidebar" },
      event: (s) => s.emit("session.deleted", {}),
    },
  ],
  "session.updated": [
    {
      shows: { view: "titleBar", what: "the session's new title" },
      event: (s) =>
        s.emit("session.updated", {
          title: "Split the bill evenly",
          mode: "default",
          model: "qwen3.8-27b-q8",
          modelInfo: null,
          effort: null,
          archived: false,
          additionalDirectories: [],
          changed: ["title"],
        }),
    },
  ],
  "turn.started": [
    {
      shows: { view: "transcript", what: "the person's message" },
      before: working,
      event: (s) => turnStarted(s),
    },
  ],
  "turn.finished": [
    {
      shows: { view: "transcript", what: "the turn summary under the reply" },
      before: running,
      event: (s) =>
        s.emit("turn.finished", {
          turnId: "t1",
          stopReason: "completed",
          finalText: "Done.",
          error: null,
          durationMs: 4800,
        }),
    },
  ],
  "message.started": [
    {
      shows: { view: "transcript", what: "the prompt-reading line gives way to the reply" },
      before: (s) => {
        running(s);
        s.emit("prompt.progress", { turnId: "t1", total: 20_000, cached: 0, processed: 4_000 });
      },
      event: messageStarted,
    },
    {
      shows: { view: "transcript", what: "“Thought for 6 s”: reasoning timed from the start" },
      replay: true,
      before: running,
      event: messageStarted,
      after: (s) =>
        s.emit(
          "message.finished",
          {
            turnId: "t1",
            messageId: "m1",
            text: "The split rounds each share.",
            reasoning: "Each share is rounded down.",
            toolCalls: [],
          },
          6000,
        ),
    },
  ],
  "message.delta": [
    {
      shows: { view: "transcript", what: "the reply's text as it streams" },
      before: (s) => {
        running(s);
        messageStarted(s);
      },
      event: (s) => s.emit("message.delta", { turnId: "t1", messageId: "m1", text: "Let me " }),
    },
  ],
  "message.finished": [
    {
      shows: { view: "transcript", what: "the reply in full" },
      before: (s) => {
        running(s);
        messageStarted(s);
      },
      event: (s) =>
        s.emit("message.finished", {
          turnId: "t1",
          messageId: "m1",
          text: "Found it: rounding each share loses a cent.",
          reasoning: null,
          toolCalls: [],
        }),
    },
  ],
  "reasoning.delta": [
    {
      shows: { view: "transcript", what: "the reasoning block as it streams" },
      before: (s) => {
        running(s);
        messageStarted(s);
      },
      event: (s) =>
        s.emit("reasoning.delta", { turnId: "t1", messageId: "m1", text: "The split rounds " }),
    },
  ],
  "tool.started": [
    {
      shows: { view: "transcript", what: "the tool card, running" },
      before: (s) => {
        running(s);
        replyWithCall(s, "Read");
      },
      event: (s) =>
        s.emit("tool.started", {
          turnId: "t1",
          messageId: "m1",
          toolCallId: "c1",
          toolName: "Read",
          input: { file_path: `${PROJECT}/src/tally/money.py` },
        }),
    },
  ],
  "tool.progress": [
    {
      shows: { view: "transcript", what: "the command's live output in its card" },
      before: bashStarted,
      event: (s) =>
        s.emit("tool.progress", {
          turnId: "t1",
          toolCallId: "c1",
          progress: { kind: "output", stream: "stdout", text: "..F..\n" },
        }),
    },
    {
      shows: { view: "transcript", what: "the card's status line" },
      before: bashStarted,
      event: (s) =>
        s.emit("tool.progress", {
          turnId: "t1",
          toolCallId: "c1",
          progress: { kind: "status", message: "8 of 8 tests · 1 failure" },
        }),
    },
  ],
  "tool.finished": [
    {
      shows: { view: "transcript", what: "the card's result and state" },
      before: bashStarted,
      event: (s) =>
        s.emit("tool.finished", {
          turnId: "t1",
          toolCallId: "c1",
          toolName: "Bash",
          outcome: "success",
          content: [{ type: "text", text: "8 passed" }],
          display: null,
          durationMs: 2100,
        }),
    },
  ],
  "permission.requested": [
    {
      shows: { view: "transcript", what: "the permission card" },
      before: bashStarted,
      event: permissionRequested,
    },
  ],
  "question.asked": [
    {
      shows: { view: "transcript", what: "the question card" },
      before: (s) => {
        running(s);
        replyWithCall(s, "AskUserQuestion");
      },
      event: (s) =>
        s.emit("question.asked", {
          turnId: "t1",
          requestId: "q1",
          toolCallId: "c1",
          questions: [
            { question: "Which file?", options: [{ label: "a.py" }], multiSelect: false },
          ],
        }),
    },
  ],
  "plan.proposed": [
    {
      shows: { view: "planPane", what: "the proposed plan" },
      before: (s) => {
        running(s);
        replyWithCall(s, "ExitPlanMode");
      },
      event: (s) =>
        s.emit("plan.proposed", {
          turnId: "t1",
          requestId: "r1",
          toolCallId: "c1",
          plan: "# Plan\n\n1. Round once at the end.",
          planPath: null,
          modeBeforePlan: "default",
        }),
    },
  ],
  "elicitation.requested": [
    {
      shows: { view: "transcript", what: "the server's form, labelled with the server" },
      before: (s) => {
        running(s);
        replyWithCall(s, "mcp__tracker__create_issue");
        s.emit("tool.started", {
          turnId: "t1",
          messageId: "m1",
          toolCallId: "c1",
          toolName: "mcp__tracker__create_issue",
          input: {},
        });
      },
      event: (s) =>
        s.emit("elicitation.requested", {
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
        }),
    },
    {
      shows: { view: "sidebar", what: "“Needs you: open a page for tracker”" },
      before: running,
      event: (s) =>
        s.emit("elicitation.requested", {
          turnId: "t1",
          requestId: "e2",
          toolCallId: null,
          server: "tracker",
          message: "Sign in",
          mode: "url",
          fields: [],
          url: "https://tracker.example.com/connect",
        }),
    },
  ],
  "request.resolved": [
    {
      shows: { view: "transcript", what: "the card closes to its one-line record" },
      before: (s) => {
        bashStarted(s);
        permissionRequested(s);
      },
      event: (s) =>
        s.emit("request.resolved", {
          kind: "permission",
          turnId: "t1",
          requestId: "p1",
          outcome: "answered",
          response: { behavior: "allow", scope: "once" },
        }),
    },
  ],
  "tasks.updated": [
    {
      shows: { view: "titleBar", what: "the task count, “1 of 2”" },
      before: running,
      event: (s) =>
        s.emit("tasks.updated", {
          tasks: [
            { content: "Add tests for refunds", status: "completed" },
            { content: "Handle negative totals", status: "pending" },
          ],
        }),
    },
  ],
  "hook.ran": [
    {
      shows: { view: "transcript", what: "“PreToolUse hook blocked Bash: …” beside the call" },
      before: bashStarted,
      event: (s) =>
        s.emit("hook.ran", {
          turnId: "t1",
          toolCallId: "c1",
          hook: {
            event: "PreToolUse",
            matcher: "Bash",
            type: "command",
            command: "./scripts/check-command.sh",
            source: {
              path: `${PROJECT}/.claude/settings.json`,
              origin: "claude",
              scope: "project",
            },
          },
          outcome: "blocked",
          exitCode: 2,
          durationMs: 41,
          decision: "deny",
          message: "rm -rf is not allowed in this project",
        }),
    },
    {
      shows: { view: "transcript", what: "a SessionStart hook's line, outside any turn" },
      event: (s) =>
        s.emit("hook.ran", {
          turnId: null,
          toolCallId: null,
          hook: {
            event: "SessionStart",
            matcher: "startup",
            type: "command",
            command: "./scripts/context.sh",
            source: { path: `${HOME}/.dawg/settings.json`, origin: "dawg", scope: "user" },
          },
          outcome: "success",
          exitCode: 0,
          durationMs: 12,
          decision: null,
          message: null,
        }),
    },
  ],
  "hook.skipped": [
    {
      shows: { view: "transcript", what: "the quiet line about hooks waiting for approval" },
      before: running,
      event: (s) =>
        s.emit("hook.skipped", {
          turnId: "t1",
          projectDir: PROJECT,
          sources: [
            { path: `${PROJECT}/.claude/settings.json`, origin: "claude", scope: "project" },
          ],
        }),
    },
  ],
  "background.updated": [
    {
      shows: { view: "tasksPane", what: "the background command and its state" },
      event: (s) => s.emit("background.updated", { task: makeBackgroundTask("bash-1") }),
    },
  ],
  "subagent.updated": [
    {
      shows: { view: "transcript", what: "the Agent card's live state" },
      before: (s) => {
        running(s);
        replyWithCall(s, "Agent");
        s.emit("tool.started", {
          turnId: "t1",
          messageId: "m1",
          toolCallId: "c1",
          toolName: "Agent",
          input: {
            description: "Find the config loader",
            prompt: "Find where the config is loaded",
            subagent_type: "Explore",
          },
        });
      },
      event: (s) => s.emit("subagent.updated", { agent: makeSubagent("agent-1") }),
    },
    {
      shows: { view: "tasksPane", what: "the background agent and its state" },
      event: (s) =>
        s.emit("subagent.updated", {
          agent: makeSubagent("agent-1", { background: true, status: "queued", queuePosition: 1 }),
        }),
    },
  ],
  "usage.updated": [
    {
      shows: { view: "composer", what: "the context meter" },
      event: (s) =>
        s.emit("usage.updated", {
          usage: makeUsage({ requests: 3, promptTokens: 9000, cachedTokens: 8000 }),
        }),
    },
  ],
  "prompt.progress": [
    {
      shows: { view: "transcript", what: "the line saying how far the prompt is read" },
      before: running,
      event: (s) =>
        s.emit("prompt.progress", { turnId: "t1", total: 20_000, cached: 0, processed: 4_000 }),
    },
  ],
  "compaction.started": [
    {
      shows: { view: "transcript", what: "the “Compacting” divider" },
      event: compactionStarted,
    },
  ],
  "compaction.finished": [
    {
      shows: { view: "transcript", what: "the divider's result, context before and after" },
      before: compactionStarted,
      event: (s) =>
        s.emit("compaction.finished", {
          compactionId: "k1",
          outcome: "completed",
          summary: "We fixed the split.",
          contextBefore: 140_000,
          contextAfter: 21_600,
          error: null,
        }),
    },
  ],
  error: [
    {
      shows: { view: "transcript", what: "the error card" },
      before: running,
      event: (s) =>
        s.emit("error", {
          turnId: "t1",
          error: {
            kind: "model_unavailable",
            message: "The model stopped responding.",
            detail: null,
            retryable: true,
          },
        }),
    },
  ],
};

// --- Running a scenario ------------------------------------------------------------------------

function appState(slice: EngineSlice): AppStore {
  const option = MOCK_MODELS[0]?.option;
  const base = initialAppState(HOME);
  return {
    ...base,
    ...slice,
    models: MOCK_MODELS.map((model) => model.option),
    modelStatus: {
      state: "ready",
      modelId: option?.id ?? null,
      label: null,
      message: null,
      memoryBytes: null,
    },
    layout: { ...base.layout, selectedSessionId: ID },
    resolvedTheme: "dark",
    actions: {} as AppActions,
  };
}

/** The session open and loaded, then `events` as live events or as one replay. */
function build(scenario: Scenario, events: ReturnType<Stream["emit"]>[]): EngineSlice {
  const summary = makeSummary(ID, { lastActivityAt: T0 - 60_000 });
  const opened: ReducerInput[] = [
    { type: "snapshot", snapshot: makeSnapshot(summary, scenario.snapshot ?? {}) },
  ];
  if (scenario.replay) {
    return reduceAll(emptyEngineSlice(), [
      ...opened,
      { type: "replay", sessionId: ID, events, done: true },
    ]);
  }
  let slice = reduceAll(emptyEngineSlice(), [
    ...opened,
    { type: "replay", sessionId: ID, events: [], done: true },
  ]);
  for (const event of events) slice = reduceAll(slice, [{ type: "event", event }]);
  return slice;
}

function run(scenario: Scenario) {
  const stream = createStream(ID);
  scenario.before?.(stream);
  const at = stream.events.length;
  scenario.event(stream);
  if (stream.events.length !== at + 1) throw new Error("A scenario's `event` emits one event.");
  const event = stream.events[at];
  scenario.after?.(stream);
  const all = [...stream.events];
  const without = all.filter((_, index) => index !== at);
  return {
    event,
    withEvent: build(scenario, all),
    withoutEvent: build(scenario, without),
  };
}

/** The slice as plain data, without high-water marks (every applied event raises them). */
function engineFacts(slice: EngineSlice): string {
  const sessions = Object.fromEntries(
    Object.entries(slice.sessions).map(([id, session]) => [id, { ...session, highWaterSeq: 0 }]),
  );
  return JSON.stringify({ ...slice, sessions });
}

function rendered(slice: EngineSlice, view: View): string {
  return JSON.stringify(VIEWS[view](appState(slice)) ?? null);
}

describe("every protocol event has a visible representation", () => {
  it("covers exactly the protocol's events", () => {
    expect(Object.keys(COVERAGE).sort()).toEqual([...EVENT_NAMES].sort());
    expect(Object.keys(IGNORED)).toEqual([]);
  });

  const cases = Object.entries(COVERAGE).flatMap(([name, scenarios]) =>
    scenarios.map((scenario) => ({ name, scenario })),
  );
  it.each(cases)("$name: $scenario.shows.view shows $scenario.shows.what", ({ name, scenario }) => {
    expect(scenario.event).toBeDefined();
    const { event, withEvent, withoutEvent } = run(scenario);
    expect(event?.event).toBe(name);
    // The reducer takes the event in.
    if (!(name in IGNORED)) expect(engineFacts(withEvent)).not.toBe(engineFacts(withoutEvent));
    // And the window draws something different because of it.
    const view = scenario.shows.view;
    expect(rendered(withEvent, view)).not.toBe(rendered(withoutEvent, view));
  });
});
