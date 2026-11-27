/**
 * Builders for transcript and card tests: items shaped exactly as `state/types.ts` describes,
 * with sample data from the approved mockup. Only tests import this module.
 */
import type { PermissionRequest } from "@dawg/protocol";
import { vi } from "vitest";
import type {
  AssistantTextItem,
  CommandOutputItem,
  CompactionItem,
  ErrorItem,
  NoteItem,
  PermissionItem,
  PlanItem,
  QuestionItem,
  ReasoningItem,
  TasksItem,
  ToolCallItem,
  TranscriptView,
  TurnSummaryItem,
  UserMessageItem,
} from "../state/types.ts";
import type { TranscriptProps } from "./contract.ts";
import type { TranscriptEnv } from "./env.ts";

export const CWD = "/Users/me/code/tally";
export const HOME = "/Users/me";

let counter = 0;
function nextSeq(): number {
  counter += 1;
  return counter;
}

export function userItem(overrides: Partial<UserMessageItem> = {}): UserMessageItem {
  return {
    id: "user-1",
    turnId: "turn-1",
    seq: nextSeq(),
    kind: "user",
    text: "The test suite fails on `test_split_evenly_keeps_every_cent`. Fix it without changing the test.",
    images: [],
    mentions: [],
    command: null,
    ...overrides,
  };
}

export function assistantItem(overrides: Partial<AssistantTextItem> = {}): AssistantTextItem {
  return {
    id: "assistant-1",
    turnId: "turn-1",
    seq: nextSeq(),
    kind: "assistant",
    messageId: "message-1",
    text: "Fixed. `split_evenly` rounded every share to the cent.",
    streaming: false,
    ...overrides,
  };
}

export function reasoningItem(overrides: Partial<ReasoningItem> = {}): ReasoningItem {
  return {
    id: "reasoning-1",
    turnId: "turn-1",
    seq: nextSeq(),
    kind: "reasoning",
    messageId: "message-1",
    text: "The test wants three parts that add up to 100.00.",
    streaming: false,
    startedAt: 1_000,
    durationMs: 5_000,
    ...overrides,
  };
}

export function toolItem(overrides: Partial<ToolCallItem> = {}): ToolCallItem {
  return {
    id: "tool-1",
    turnId: "turn-1",
    seq: nextSeq(),
    kind: "tool",
    toolCallId: "call-1",
    messageId: "message-1",
    toolName: "Bash",
    input: { command: "uv run pytest -q" },
    state: "success",
    output: [],
    statusLine: null,
    content: [{ type: "text", text: "8 passed in 0.19s" }],
    display: {
      kind: "command",
      command: "uv run pytest -q",
      cwd: CWD,
      exitCode: 0,
      durationMs: 800,
      timedOut: false,
      interrupted: false,
      backgroundTaskId: null,
      outputPath: null,
      output: "8 passed in 0.19s",
      notes: [],
    },
    startedAt: 1_000,
    durationMs: 800,
    permissionRequestId: null,
    ...overrides,
  };
}

/**
 * A failed command from a session stored before engines reported `output` and `notes`: the card
 * takes the model's text apart, colours included.
 */
export function bashFailure(overrides: Partial<ToolCallItem> = {}): ToolCallItem {
  return toolItem({
    id: "tool-fail",
    state: "error",
    content: [
      {
        type: "text",
        // As the engine records it: "Error: " from markAsError, the "Exit code" footer from Bash.
        text: "Error: \u001b[1m===== FAILURES =====\u001b[0m\n\u001b[31mE       AssertionError\u001b[0m\n\nExit code 1",
      },
    ],
    display: {
      kind: "command",
      command: "uv run pytest -q",
      cwd: CWD,
      exitCode: 1,
      durationMs: 900,
      timedOut: false,
      interrupted: false,
      backgroundTaskId: null,
      outputPath: null,
      output: null,
      notes: [],
    },
    durationMs: 900,
    ...overrides,
  });
}

/** A Read of a 42-line file, with the tool's "12→" prefixes. */
export function readItem(overrides: Partial<ToolCallItem> = {}): ToolCallItem {
  const lines = Array.from({ length: 42 }, (_, i) => `line ${i + 1} of money.py`);
  const text = lines.map((line, i) => `${String(i + 1).padStart(2)}→${line}`).join("\n");
  return toolItem({
    id: "tool-read",
    toolName: "Read",
    input: { file_path: `${CWD}/src/tally/money.py` },
    content: [{ type: "text", text }],
    display: {
      kind: "file",
      filePath: `${CWD}/src/tally/money.py`,
      startLine: 1,
      lineCount: 42,
      totalLines: 42,
      truncated: false,
    },
    ...overrides,
  });
}

export const MONEY_HUNKS = [
  {
    oldStart: 10,
    oldLines: 6,
    newStart: 10,
    newLines: 10,
    lines: [
      " def split_evenly(total: Decimal, parts: int) -> list[Decimal]:",
      "-    share = (total / parts).quantize(CENT, rounding=ROUND_HALF_UP)",
      "-    return [share] * parts",
      "+    cents = int((total / CENT).to_integral_value())",
      "+    base, extra = divmod(cents, parts)",
      "+    return [(base + (1 if i < extra else 0)) * CENT for i in range(parts)]",
    ],
  },
];

export function editItem(overrides: Partial<ToolCallItem> = {}): ToolCallItem {
  return toolItem({
    id: "tool-edit",
    toolName: "Edit",
    input: { file_path: `${CWD}/src/tally/money.py`, old_string: "a", new_string: "b" },
    content: [{ type: "text", text: "Edited src/tally/money.py" }],
    display: {
      kind: "diff",
      filePath: `${CWD}/src/tally/money.py`,
      created: false,
      hunks: MONEY_HUNKS,
      additions: 3,
      deletions: 2,
    },
    ...overrides,
  });
}

export function grepItem(overrides: Partial<ToolCallItem> = {}): ToolCallItem {
  const rows = [
    "src/a.py:1:currency",
    "src/a.py:5:currency",
    "src/b.py:2:currency",
    "src/c.py:3:currency",
    "src/d.py:4:currency",
    "src/e.py:7:currency",
    "src/f.py:9:currency",
  ];
  return toolItem({
    id: "tool-grep",
    toolName: "Grep",
    input: { pattern: "currency", output_mode: "content" },
    content: [{ type: "text", text: rows.join("\n") }],
    display: { kind: "search", pattern: "currency", resultCount: 14, truncated: false },
    ...overrides,
  });
}

export function tasksItem(overrides: Partial<TasksItem> = {}): TasksItem {
  return {
    id: "tasks-1",
    turnId: "turn-2",
    seq: nextSeq(),
    kind: "tasks",
    tasks: [
      { content: "Add tests for refunds (negative totals)", status: "completed" },
      {
        content: "Make split_evenly handle negative totals",
        activeForm: "Making split_evenly handle negative totals",
        status: "in_progress",
      },
      { content: "Run the whole test suite", status: "pending" },
    ],
    ...overrides,
  };
}

export function permissionRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: "perm-1",
    toolCallId: "call-perm",
    toolName: "Bash",
    input: { command: "uv add --dev pytest-repeat" },
    title: "Run a shell command",
    reason: "No rule allows `uv add` in this project.",
    suggestions: ["Bash(uv add --dev *)"],
    ...overrides,
  };
}

export function permissionItem(overrides: Partial<PermissionItem> = {}): PermissionItem {
  const request = overrides.request ?? permissionRequest();
  return {
    id: "permission-1",
    turnId: "turn-1",
    seq: nextSeq(),
    kind: "permission",
    requestId: request.requestId,
    request,
    state: "pending",
    response: null,
    ...overrides,
  };
}

export function questionItem(overrides: Partial<QuestionItem> = {}): QuestionItem {
  return {
    id: "question-1",
    turnId: "turn-1",
    seq: nextSeq(),
    kind: "question",
    requestId: "question-req-1",
    toolCallId: "call-question",
    questions: [
      {
        question: "How should the tip be shared?",
        header: "Tip split",
        multiSelect: false,
        options: [
          {
            label: "Evenly, with the bill",
            description: "Add the tip to the total, then split everything the same way",
          },
          {
            label: "By what each person ordered",
            description: "Each person tips on their own `items`",
          },
          {
            label: "Only among people who opt in",
            description: "Everyone else pays their share without a tip",
          },
        ],
      },
    ],
    state: "pending",
    response: null,
    ...overrides,
  };
}

export const PLAN_TEXT = [
  "#### Goal",
  "Receipt totals come out in the receipt’s home currency.",
  "",
  "#### Steps",
  "1. Add a `Money` type to `money.py`.",
  "2. Add `rates.py`: a rates table read from `rates.json`.",
].join("\n");

export function planItem(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: "plan-1",
    turnId: "turn-1",
    seq: nextSeq(),
    kind: "plan",
    requestId: "plan-req-1",
    toolCallId: "call-plan",
    plan: PLAN_TEXT,
    planPath: `${CWD}/.dawg/plans/multi-currency-totals.md`,
    state: "pending",
    response: null,
    modeBeforePlan: "default",
    ...overrides,
  };
}

export function noteItem(overrides: Partial<NoteItem> = {}): NoteItem {
  return {
    id: "note-1",
    turnId: "turn-1",
    seq: nextSeq(),
    kind: "note",
    text: "Interrupted by you · the transcript keeps every finished call",
    tone: "neutral",
    ...overrides,
  };
}

export function compactionItem(overrides: Partial<CompactionItem> = {}): CompactionItem {
  return {
    id: "compaction-1",
    turnId: null,
    seq: nextSeq(),
    kind: "compaction",
    compactionId: "compaction-1",
    trigger: "manual",
    state: "completed",
    contextBefore: 74_200,
    contextAfter: 21_600,
    summary:
      "The person asked to fix the split test. **Done so far:** money.py now works in cents.",
    error: null,
    ...overrides,
  };
}

export function summaryItem(overrides: Partial<TurnSummaryItem> = {}): TurnSummaryItem {
  return {
    id: "summary-1",
    turnId: "turn-1",
    seq: nextSeq(),
    kind: "turn-summary",
    stopReason: "completed",
    durationMs: 48_000,
    modelRequests: 6,
    cachedPercent: 92,
    ...overrides,
  };
}

export function errorItem(overrides: Partial<ErrorItem> = {}): ErrorItem {
  return {
    id: "error-1",
    turnId: "turn-1",
    seq: nextSeq(),
    kind: "error",
    error: {
      kind: "model_unavailable",
      message: "The model stopped responding.",
      detail: "connect ECONNREFUSED 127.0.0.1:8080",
      retryable: true,
    },
    ...overrides,
  };
}

export function commandOutputItem(overrides: Partial<CommandOutputItem> = {}): CommandOutputItem {
  return {
    id: "command-1",
    turnId: null,
    seq: nextSeq(),
    kind: "command-output",
    command: "/help",
    output: "## Commands\n\n- `/compact`: summarise the conversation",
    ...overrides,
  };
}

export function makeView(overrides: Partial<TranscriptView> = {}): TranscriptView {
  return {
    sessionId: "session-1",
    items: [],
    loaded: true,
    working: false,
    activeTurnId: null,
    promptProgress: null,
    toolCallDisplay: "smart",
    openItems: {},
    shownAgain: {},
    queuedTurnIds: {},
    cwd: CWD,
    ...overrides,
  };
}

export function makeEnv(overrides: Partial<TranscriptEnv> = {}): TranscriptEnv {
  return {
    cwd: CWD,
    homeDir: HOME,
    setItemOpen: vi.fn(),
    showCardAgain: vi.fn(),
    respondPermission: vi.fn(),
    respondQuestion: vi.fn(),
    respondPlan: vi.fn(),
    openLink: vi.fn(),
    openInChanges: null,
    reviewProjectCode: null,
    openSubagent: null,
    ...overrides,
  };
}

export function makeProps(overrides: Partial<TranscriptProps> = {}): TranscriptProps {
  return {
    sessionId: "session-1",
    view: makeView(),
    homeDir: HOME,
    autoFocusPendingCard: false,
    onSetItemOpen: vi.fn(),
    onShowCardAgain: vi.fn(),
    onRespondPermission: vi.fn(),
    onRespondQuestion: vi.fn(),
    onRespondPlan: vi.fn(),
    onOpenLink: vi.fn(),
    ...overrides,
  };
}
