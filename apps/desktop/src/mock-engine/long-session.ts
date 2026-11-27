/**
 * A synthetic long session for performance tests, in the mix a long day of work leaves behind:
 * prompts, reasoning, Markdown answers with code blocks, tool calls (reads, searches, edits with
 * their diffs, commands with their output, some failing), interrupted turns, compactions and a
 * few answered decisions (permissions allowed and denied, questions, plans).
 *
 * Dev and test only. The engine host adds it to the mock engine's sessions when
 * DAWG_MOCK_LONG_SESSION is set (`parseLongSession`); nothing else reaches it.
 *
 * The stored part is what the real engine replays: finished facts only, no deltas or progress
 * (packages/engine/src/runtime/README.md, "Events and their numbers"). Its one recorded turn,
 * played by the next prompt, streams a long answer as a fast local model would, so a test can
 * watch rendering while text streams into a long transcript.
 */
import type {
  ContentPart,
  EngineEvent,
  EventName,
  EventPayload,
  ToolDisplay,
} from "@dawg/protocol";
import { MOCK_DEFAULT_MODEL_ID } from "../shared/mock-models.ts";
import type { LoadedScenario, Scenario } from "./format.ts";
import { compactAtFor, contextBreakdown, PREFIX_TOKENS } from "./usage.ts";

export const LONG_SESSION_ID = "long-session";
export const LONG_SESSION_TITLE = "Ledger: a long day of work";
/** The session's folder; the e2e tests make it a git repository under a throwaway home. */
export const LONG_SESSION_CWD = "~/code/ledger";
/** Fewest items a long session may have: one of every kind of turn. */
export const MIN_LONG_SESSION_ITEMS = 100;
/** Most items: well past any budget, and still quick to build. */
export const MAX_LONG_SESSION_ITEMS = 50_000;

/** Deltas in the streamed answer, and the gap between them (ms at speed 1). */
export const STREAM_DELTAS = 1_200;
export const STREAM_GAP_MS = 4;

const CONTEXT_WINDOW = 204_800;
const START_TIME = 1_795_338_000_000;

/**
 * DAWG_MOCK_LONG_SESSION: how many transcript items the long session has, or null when unset.
 * Anything that is not a whole number in range is reported and ignored.
 */
export function parseLongSession(
  raw: string | undefined,
  log: (message: string) => void,
): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw.trim());
  if (Number.isInteger(value) && value >= MIN_LONG_SESSION_ITEMS && value <= MAX_LONG_SESSION_ITEMS)
    return value;
  log(
    `Ignoring DAWG_MOCK_LONG_SESSION="${raw}": it must be a whole number from ${MIN_LONG_SESSION_ITEMS} to ${MAX_LONG_SESSION_ITEMS}.`,
  );
  return null;
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

const FILES = [
  "src/ledger/accounts.ts",
  "src/ledger/import-csv.ts",
  "src/ledger/report.ts",
  "src/ledger/money.ts",
  "src/ledger/rules.ts",
  "src/cli/main.ts",
  "tests/accounts.test.ts",
  "tests/import-csv.test.ts",
  "tests/report.test.ts",
] as const;

const SUBJECTS = [
  "the monthly report",
  "CSV import",
  "account balances",
  "currency rounding",
  "categorisation rules",
  "the command-line flags",
  "duplicate detection",
  "opening balances",
  "the budget view",
  "transfers between accounts",
] as const;

const PROMPTS = [
  (s: string) => `The tests for ${s} fail since this morning. Find out why and fix it.`,
  (s: string) => `Add a test that covers ${s} with an empty ledger, then make it pass.`,
  (s: string) =>
    `Refactor ${s} so it no longer reads the clock directly. Keep the public API as it is.`,
  (s: string) => `Why is ${s} slow on a ledger with 40,000 entries? Measure first.`,
  (s: string) => `Tidy up ${s}: better names, shorter functions, no behaviour change.`,
  (s: string) => `Make ${s} handle negative amounts the way the bank statement shows them.`,
] as const;

const REASONING = [
  (s: string, f: string) =>
    `The failure is probably in ${s}. ${f} changed recently, so read it first, then search for the callers before touching anything. Running the tests after the edit will confirm the fix.`,
  (s: string, f: string) =>
    `Start with ${f}: ${s} goes through it. If the rounding happens per line rather than once at the end, totals drift by a cent. Check the tests for that case.`,
  (s: string, f: string) =>
    `${s} has two paths, one for single entries and one for batches. The batch path in ${f} skips validation. Look at both before changing either.`,
] as const;

const OPENERS = [
  (f: string) => `I'll read \`${f}\` and look for its callers first.`,
  (f: string) => `Let me look at \`${f}\` before changing anything.`,
  (f: string) => `First, the current state of \`${f}\`.`,
] as const;

const SNIPPETS = [
  {
    language: "ts",
    code: `export function balance(entries: readonly Entry[], account: AccountId): Money {
  let total = Money.zero(currencyOf(account));
  for (const entry of entries) {
    if (entry.account !== account) continue;
    total = total.add(entry.amount);
  }
  return total.rounded();
}`,
  },
  {
    language: "ts",
    code: `const rows = parse(text, { header: true, skipEmpty: true });
for (const [index, row] of rows.entries()) {
  const amount = parseAmount(row.amount);
  if (amount === null) {
    problems.push({ line: index + 2, message: \`Not an amount: \${row.amount}\` });
    continue;
  }
  entries.push({ date: row.date, amount, payee: row.payee.trim() });
}`,
  },
  {
    language: "ts",
    code: `export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function monthlyReport(ledger: Ledger, clock: Clock = systemClock): Report {
  const month = startOfMonth(clock.now());
  return summarise(ledger.entriesSince(month));
}`,
  },
  {
    language: "bash",
    code: `pnpm test -- --run tests/report.test.ts
pnpm exec tsc --noEmit
pnpm exec biome check src tests`,
  },
] as const;

const ANSWERS = [
  (s: string, f: string, snippet: (typeof SNIPPETS)[number]) =>
    `Fixed. ${capitalise(s)} rounded every line to the cent before adding, so a month with many small entries drifted.\n\n**What changed** in \`${f}\`:\n\n- Amounts are added at full precision and rounded **once**, at the end.\n- The rounding mode is half-even, as the bank uses.\n- A test with 1,000 entries of 0.001 now passes.\n\n\`\`\`${snippet.language}\n${snippet.code}\n\`\`\`\n\nAll 214 tests pass, and the type-check is clean.`,
  (s: string, f: string, snippet: (typeof SNIPPETS)[number]) =>
    `Done. The new test covers ${s} with an empty ledger; it failed before the change and passes now.\n\n1. \`${f}\` returns an empty result instead of throwing.\n2. The command-line output says "No entries yet" rather than printing an empty table.\n3. The other callers already handled an empty list.\n\n\`\`\`${snippet.language}\n${snippet.code}\n\`\`\`\n\n> The report still needs at least one account; that is checked earlier, in \`loadLedger\`.`,
  (s: string, f: string, snippet: (typeof SNIPPETS)[number]) =>
    `${capitalise(s)} now takes its time from a \`Clock\` that tests can replace. Nothing outside \`${f}\` changed, and the public functions keep their signatures (the clock is an optional last argument).\n\n\`\`\`${snippet.language}\n${snippet.code}\n\`\`\`\n\n| Check | Result |\n| --- | --- |\n| Unit tests | 214 passed |\n| Type-check | clean |\n| Lint | clean |`,
] as const;

const COMMAND_OUTPUT_PASS = (count: number, ms: number) =>
  ` ✓ tests/accounts.test.ts (38 tests) ${Math.round(ms * 0.3)}ms
 ✓ tests/import-csv.test.ts (61 tests) ${Math.round(ms * 0.4)}ms
 ✓ tests/report.test.ts (${count - 99} tests) ${Math.round(ms * 0.2)}ms

 Test Files  3 passed (3)
      Tests  ${count} passed (${count})
   Start at  09:41:12
   Duration  ${(ms / 1000).toFixed(2)}s`;

const COMMAND_OUTPUT_FAIL = (subject: string, file: string) =>
  ` ✓ tests/accounts.test.ts (38 tests) 41ms
 ❯ tests/report.test.ts (115 tests | 1 failed) 66ms
   × ${subject} > keeps every cent 12ms
     → expected '1000.00' to be '999.99'

 FAIL  tests/report.test.ts > ${subject} > keeps every cent
AssertionError: expected '1000.00' to be '999.99'

- Expected
+ Received

- 999.99
+ 1000.00

 ❯ tests/report.test.ts:48:31
     46|     const report = monthlyReport(ledger, fixedClock("2026-11-01"));
     47|     const total = report.total.toFixed(2);
     48|     expect(total).toBe("999.99");
       |                               ^
     49|   });

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 152 passed (153)
 ❯ ${file}:31:9`;

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function pick<T>(list: readonly T[], index: number): T {
  return list[index % list.length] as T;
}

/** File contents as Read shows them: "  n→line". */
function numbered(lines: readonly string[], start: number): string {
  return lines.map((line, i) => `${String(start + i).padStart(3)}→${line}`).join("\n");
}

function sourceLines(seed: number, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = seed + i;
    switch (n % 6) {
      case 0:
        out.push(`export function step${n}(entries: readonly Entry[]): Money {`);
        break;
      case 1:
        out.push(`  const total = sum(entries.map((entry) => entry.amount));`);
        break;
      case 2:
        out.push(`  if (total.isNegative()) return total.negate(); // refunds`);
        break;
      case 3:
        out.push(`  return total.rounded();`);
        break;
      case 4:
        out.push("}");
        break;
      default:
        out.push("");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

/** The fields of an event's payload other than the ones every event carries (per union member). */
type Fields<N extends EventName> =
  EventPayload<N> extends infer P
    ? P extends unknown
      ? Omit<P, "sessionId" | "seq" | "time">
      : never
    : never;

class Writer {
  readonly events: EngineEvent[] = [];
  time = START_TIME;
  #seq = 0;
  #ids = 0;
  /** Transcript items the events so far make, as the renderer's reducer counts them. */
  items = 0;
  contextUsed = PREFIX_TOKENS;
  #totals = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 };

  emit<N extends EventName>(event: N, fields: Fields<N>, after = 0): void {
    this.time += after;
    this.#seq += 1;
    const payload = { sessionId: LONG_SESSION_ID, seq: this.#seq, time: this.time, ...fields };
    this.events.push({ event, payload } as EngineEvent);
  }

  id(prefix: string): string {
    this.#ids += 1;
    return `${prefix}-${this.#ids}`;
  }

  usage(added: number, completion: number): void {
    const cached = this.contextUsed;
    const prompt = cached + added;
    this.contextUsed = prompt + completion;
    this.#totals.requests += 1;
    this.#totals.promptTokens += prompt;
    this.#totals.completionTokens += completion;
    this.#totals.cachedTokens += cached;
    this.emit("usage.updated", {
      usage: {
        contextWindow: CONTEXT_WINDOW,
        contextUsed: this.contextUsed,
        last: {
          promptTokens: prompt,
          completionTokens: completion,
          cachedTokens: cached,
          promptTokensPerSecond: 1_240,
          completionTokensPerSecond: 41.2,
        },
        totals: { ...this.#totals, malformedToolCalls: 0 },
        compactAt: compactAtFor(CONTEXT_WINDOW),
        breakdown: contextBreakdown(this.contextUsed),
      },
    });
  }
}

interface Turn {
  w: Writer;
  turnId: string;
  index: number;
  subject: string;
  file: string;
  startedAt: number;
}

const STATUS_WORKING = {
  status: "working",
  waitingOn: null,
  message: "Working",
  queuePosition: null,
} as const;
const STATUS_IDLE = {
  status: "idle",
  waitingOn: null,
  message: null,
  queuePosition: null,
} as const;

function startTurn(w: Writer, index: number, text: string): Turn {
  const turnId = w.id("turn");
  w.emit("session.status", STATUS_WORKING, 45_000);
  w.emit("turn.started", {
    turnId,
    prompt: { content: [{ type: "text", text }], mentions: [] },
    command: null,
  });
  w.items += 1;
  return {
    w,
    turnId,
    index,
    subject: pick(SUBJECTS, index),
    file: pick(FILES, index * 7),
    startedAt: w.time,
  };
}

/** One model message: reasoning and text as given, then its tool calls (started by the caller). */
function message(t: Turn, parts: { text?: string; reasoning?: string; calls?: Call[] }): string {
  const { w } = t;
  const messageId = w.id("message");
  w.emit("message.started", { turnId: t.turnId, messageId }, 900);
  const text = parts.text ?? "";
  const reasoning = parts.reasoning ?? null;
  w.emit(
    "message.finished",
    {
      turnId: t.turnId,
      messageId,
      text,
      reasoning,
      toolCalls: (parts.calls ?? []).map((c) => ({ toolCallId: c.id, toolName: c.name })),
    },
    2_000 + text.length * 6,
  );
  if (text.trim() !== "") w.items += 1;
  if (reasoning !== null && reasoning.trim() !== "") w.items += 1;
  w.usage(1_100, Math.ceil((text.length + (reasoning?.length ?? 0)) / 3.6) + 40);
  return messageId;
}

function tool(
  t: Turn,
  messageId: string,
  made: Call,
  input: Record<string, unknown>,
  result: {
    outcome: "success" | "error" | "denied" | "interrupted";
    text: string;
    display: ToolDisplay | null;
    durationMs: number;
  },
  between?: () => void,
): void {
  const { w } = t;
  w.emit(
    "tool.started",
    { turnId: t.turnId, messageId, toolCallId: made.id, toolName: made.name, input },
    10,
  );
  if (!HIDDEN.has(made.name)) w.items += 1;
  between?.();
  const content: ContentPart[] = [{ type: "text", text: result.text }];
  w.emit(
    "tool.finished",
    {
      turnId: t.turnId,
      toolCallId: made.id,
      toolName: made.name,
      outcome: result.outcome,
      content,
      display: result.display,
      durationMs: result.outcome === "denied" ? null : result.durationMs,
    },
    result.durationMs,
  );
}

/** Tools the transcript shows as their decision cards instead. */
const HIDDEN: ReadonlySet<string> = new Set(["AskUserQuestion", "ExitPlanMode", "TodoWrite"]);

function finishTurn(
  t: Turn,
  finalText: string | null,
  stopReason: "completed" | "interrupted",
): void {
  const { w } = t;
  w.emit(
    "turn.finished",
    {
      turnId: t.turnId,
      stopReason,
      finalText,
      error: null,
      durationMs: w.time + 20 - t.startedAt,
    },
    20,
  );
  // A summary line for a finished turn; a note for an interrupted one.
  w.items += 1;
  w.emit("session.status", STATUS_IDLE);
}

interface Call {
  id: string;
  name: string;
}

function call(w: Writer, name: string): Call {
  return { id: w.id("call"), name };
}

function readCall(t: Turn, messageId: string, read: Call, file = t.file): void {
  const lines = sourceLines(t.index * 3, 18 + (t.index % 30));
  tool(
    t,
    messageId,
    read,
    { file_path: `${LONG_SESSION_CWD}/${file}` },
    {
      outcome: "success",
      text: numbered(lines, 1),
      display: {
        kind: "file",
        filePath: `${LONG_SESSION_CWD}/${file}`,
        startLine: 1,
        lineCount: lines.length,
        totalLines: lines.length + 40,
        truncated: false,
      },
      durationMs: 12,
    },
  );
}

function grepCall(t: Turn, messageId: string, grep: Call): void {
  const pattern = `step${t.index % 40}\\b`;
  const hits = FILES.slice(0, 3 + (t.index % 5)).map(
    (f, i) =>
      `${LONG_SESSION_CWD}/${f}:${10 + i * 7}:  const total = step${t.index % 40}(entries);`,
  );
  tool(
    t,
    messageId,
    grep,
    { pattern, output_mode: "content" },
    {
      outcome: "success",
      text: hits.join("\n"),
      display: { kind: "search", pattern, resultCount: hits.length, truncated: false },
      durationMs: 38,
    },
  );
}

function editCall(t: Turn, messageId: string, edit: Call): void {
  const start = 10 + (t.index % 50);
  const before = sourceLines(t.index, 4 + (t.index % 6));
  const after = before.map((line) =>
    line.replace("sum(", "sumPrecise(").replace("refunds", "refunds stay negative"),
  );
  const added = ["  // Round once, at the end, so many small entries do not drift.", ...after];
  const lines = [
    ...before.slice(0, 2).map((l) => ` ${l}`),
    ...before.slice(2).map((l) => `-${l}`),
    ...added.slice(3).map((l) => `+${l}`),
    "   return total;",
  ];
  const deletions = before.length - 2;
  const additions = added.length - 3;
  const path = `${LONG_SESSION_CWD}/${t.file}`;
  tool(
    t,
    messageId,
    edit,
    { file_path: path, old_string: before.join("\n"), new_string: after.join("\n") },
    {
      outcome: "success",
      text: `Edited ${path}.`,
      display: {
        kind: "diff",
        filePath: path,
        created: false,
        hunks: [
          {
            oldStart: start,
            oldLines: 2 + deletions + 1,
            newStart: start,
            newLines: 2 + additions + 1,
            lines,
          },
        ],
        additions,
        deletions,
      },
      durationMs: 18,
    },
  );
}

function bashCall(t: Turn, messageId: string, bash: Call, fail: boolean): void {
  const command = "pnpm test -- --run";
  const ms = 1_800 + (t.index % 17) * 90;
  const output = fail ? COMMAND_OUTPUT_FAIL(t.subject, t.file) : COMMAND_OUTPUT_PASS(214, ms);
  tool(
    t,
    messageId,
    bash,
    { command, description: "Run the test suite" },
    {
      outcome: fail ? "error" : "success",
      text: fail ? `Error: ${output}\n\nExit code 1` : output,
      display: {
        kind: "command",
        command,
        cwd: LONG_SESSION_CWD,
        exitCode: fail ? 1 : 0,
        durationMs: ms,
        timedOut: false,
        interrupted: false,
        backgroundTaskId: null,
        outputPath: null,
        output,
        notes: [],
      },
      durationMs: ms,
    },
  );
}

function answerText(t: Turn): string {
  return pick(ANSWERS, t.index)(t.subject, t.file, pick(SNIPPETS, t.index * 5));
}

// --- Kinds of turn ---------------------------------------------------------------------------

/** Read, search, edit, test, answer: 9 items (11 when the first test run fails). */
function workTurn(w: Writer, index: number): void {
  const prompt =
    index === 0 ? LONG_SESSION_FIRST_PROMPT : pick(PROMPTS, index)(pick(SUBJECTS, index));
  const t = startTurn(w, index, prompt);
  const read = call(w, "Read");
  const grep = call(w, "Grep");
  const first = message(t, {
    reasoning: pick(REASONING, index)(t.subject, t.file),
    text: pick(OPENERS, index)(t.file),
    calls: [read, grep],
  });
  readCall(t, first, read);
  grepCall(t, first, grep);
  const edit = call(w, "Edit");
  editCall(t, message(t, { calls: [edit] }), edit);
  const failsFirst = index % 7 === 3;
  const bash = call(w, "Bash");
  bashCall(t, message(t, { calls: [bash] }), bash, failsFirst);
  if (failsFirst) {
    const fix = call(w, "Edit");
    editCall(t, message(t, { text: "One case left: refunds. Fixing that.", calls: [fix] }), fix);
    const again = call(w, "Bash");
    bashCall(t, message(t, { calls: [again] }), again, false);
  }
  const answer = answerText(t);
  message(t, { text: answer });
  finishTurn(t, answer, "completed");
}

/** Stopped while a command ran: 5 items, ending in a note. */
function interruptedTurn(w: Writer, index: number): void {
  const t = startTurn(
    w,
    index,
    `Run the full test suite with coverage for ${pick(SUBJECTS, index)}.`,
  );
  const bash = call(w, "Bash");
  const m = message(t, {
    reasoning: "Coverage needs the slow suite. Start it and report the numbers.",
    text: "Running the whole suite with coverage; it takes a minute or two.",
    calls: [bash],
  });
  tool(
    t,
    m,
    bash,
    { command: "pnpm test -- --coverage", description: "Run the suite with coverage" },
    {
      outcome: "interrupted",
      text: "The command was interrupted.",
      display: {
        kind: "command",
        command: "pnpm test -- --coverage",
        cwd: LONG_SESSION_CWD,
        exitCode: null,
        durationMs: 6_100,
        timedOut: false,
        interrupted: true,
        backgroundTaskId: null,
        outputPath: null,
        output:
          " ✓ tests/accounts.test.ts (38 tests) 41ms\n ✓ tests/import-csv.test.ts (61 tests) 77ms",
        notes: [],
      },
      durationMs: 6_100,
    },
  );
  finishTurn(t, null, "interrupted");
}

/** A command that needs permission, allowed (7 items) or denied (6 items, the call hidden). */
function permissionTurn(w: Writer, index: number, allow: boolean): void {
  const t = startTurn(
    w,
    index,
    `Add the date-fns package and use it for ${pick(SUBJECTS, index)}.`,
  );
  const bash = call(w, "Bash");
  const m = message(t, {
    text: "That needs a new dependency. Adding it with pnpm.",
    calls: [bash],
  });
  const requestId = w.id("request");
  const input = { command: "pnpm add date-fns", description: "Add date-fns as a dependency" };
  const ask = () => {
    w.emit(
      "permission.requested",
      {
        turnId: t.turnId,
        request: {
          requestId,
          toolCallId: bash.id,
          toolName: "Bash",
          input,
          title: "Run a shell command",
          reason:
            "Adds a dependency: changes package.json and pnpm-lock.yaml and downloads a package. No rule allows `pnpm add` in this project.",
          suggestions: ["Bash(pnpm add *)"],
        },
      },
      8,
    );
    w.items += 1;
    w.emit("session.status", {
      status: "waiting",
      waitingOn: "permission",
      message: "Waiting for permission",
      queuePosition: null,
    });
    w.emit(
      "request.resolved",
      {
        kind: "permission",
        turnId: t.turnId,
        requestId,
        outcome: "answered",
        response: allow
          ? { behavior: "allow", scope: "once" }
          : { behavior: "deny", message: "Use the built-in Intl.DateTimeFormat instead." },
      },
      14_000,
    );
    w.emit("session.status", STATUS_WORKING);
  };
  if (allow) {
    tool(
      t,
      m,
      bash,
      input,
      {
        outcome: "success",
        text: "Packages: +1\n+ date-fns 4.1.0\nDone in 1.4s",
        display: {
          kind: "command",
          command: input.command,
          cwd: LONG_SESSION_CWD,
          exitCode: 0,
          durationMs: 1_400,
          timedOut: false,
          interrupted: false,
          backgroundTaskId: null,
          outputPath: null,
          output: "Packages: +1\n+ date-fns 4.1.0\nDone in 1.4s",
          notes: [],
        },
        durationMs: 1_400,
      },
      ask,
    );
    const edit = call(w, "Edit");
    editCall(t, message(t, { calls: [edit] }), edit);
  } else {
    tool(
      t,
      m,
      bash,
      input,
      {
        outcome: "denied",
        text: "The person denied this command: Use the built-in Intl.DateTimeFormat instead.",
        display: null,
        durationMs: 0,
      },
      ask,
    );
  }
  const answer = allow
    ? `Added **date-fns** and switched ${t.subject} to \`format\` and \`startOfMonth\` from it.`
    : `Understood. ${capitalise(t.subject)} keeps using \`Intl.DateTimeFormat\`; no new dependency.`;
  message(t, { text: answer });
  finishTurn(t, answer, "completed");
}

/** A question, answered: 5 items. */
function questionTurn(w: Writer, index: number): void {
  const t = startTurn(w, index, `Show ${pick(SUBJECTS, index)} per category as well.`);
  const ask = call(w, "AskUserQuestion");
  const m = message(t, { text: "One decision before I change the layout:", calls: [ask] });
  const questions = [
    {
      question: "Where should the per-category totals go?",
      header: "Layout",
      options: [
        { label: "Below the account totals", description: "One long report" },
        { label: "In a second table", description: "Easier to scan" },
        { label: "Behind a --by-category flag", description: "The default stays as it is" },
      ],
      multiSelect: false,
    },
  ];
  const requestId = w.id("request");
  tool(
    t,
    m,
    ask,
    { questions },
    {
      outcome: "success",
      text: "The person chose: In a second table.",
      display: null,
      durationMs: 21_000,
    },
    () => {
      w.emit("question.asked", { turnId: t.turnId, requestId, toolCallId: ask.id, questions }, 8);
      w.items += 1;
      w.emit("session.status", {
        status: "waiting",
        waitingOn: "question",
        message: "Waiting for an answer",
        queuePosition: null,
      });
      w.emit(
        "request.resolved",
        {
          kind: "question",
          turnId: t.turnId,
          requestId,
          outcome: "answered",
          response: {
            outcome: "answered",
            answers: [{ question: questions[0]?.question ?? "", selected: ["In a second table"] }],
          },
        },
        21_000,
      );
      w.emit("session.status", STATUS_WORKING);
    },
  );
  const edit = call(w, "Edit");
  editCall(t, message(t, { calls: [edit] }), edit);
  const answer = `The report now ends with a second table of totals per category, sorted by amount.`;
  message(t, { text: answer });
  finishTurn(t, answer, "completed");
}

/** A plan, approved: 6 items. */
function planTurn(w: Writer, index: number): void {
  const t = startTurn(w, index, `Plan how to split ${pick(SUBJECTS, index)} into its own module.`);
  const exit = call(w, "ExitPlanMode");
  const plan = `### Goal\n\nMove ${t.subject} into its own module with no behaviour change.\n\n### Steps\n\n1. Create \`src/ledger/${t.subject.replace(/\W+/g, "-")}.ts\` and move the functions.\n2. Re-export them from \`src/ledger/index.ts\` so callers keep working.\n3. Move the tests next to it.\n4. Run the suite and the type-check.\n\n### Not changing\n\nThe file formats and the command-line flags.`;
  const m = message(t, {
    reasoning: "Read enough to plan. Present it before editing.",
    calls: [exit],
  });
  const requestId = w.id("request");
  tool(
    t,
    m,
    exit,
    { plan },
    {
      outcome: "success",
      text: "The person approved the plan. Carry out the plan.",
      display: null,
      durationMs: 30_000,
    },
    () => {
      w.emit(
        "plan.proposed",
        {
          turnId: t.turnId,
          requestId,
          toolCallId: exit.id,
          plan,
          planPath: `~/.dawg/plans/ledger-${index}.md`,
          modeBeforePlan: "default",
        },
        8,
      );
      w.items += 1;
      w.emit("session.status", {
        status: "waiting",
        waitingOn: "plan",
        message: "Waiting for plan approval",
        queuePosition: null,
      });
      w.emit(
        "request.resolved",
        {
          kind: "plan",
          turnId: t.turnId,
          requestId,
          outcome: "answered",
          response: { decision: "approve" },
        },
        30_000,
      );
      w.emit("session.status", STATUS_WORKING);
    },
  );
  const edit = call(w, "Edit");
  editCall(t, message(t, { calls: [edit] }), edit);
  const answer = `Moved ${t.subject} into its own module. Callers import it as before; the suite passes.`;
  message(t, { text: answer });
  finishTurn(t, answer, "completed");
}

/** The session's first prompt, for tests to look for. */
export const LONG_SESSION_FIRST_PROMPT =
  "Good morning. The tests for the monthly report fail since last night; find out why.";

/** The session's last prompt and the start of its last answer, for tests to look for. */
export const LONG_SESSION_LAST_PROMPT = "Last question for today: where does each part live?";
export const LONG_SESSION_LAST_ANSWER = "That is the last answer of the day.";

/** Reads the files a short question needs, then answers: 3 + `reads` items. */
function shortTurn(w: Writer, index: number, reads: number, last = false): void {
  const prompt = last ? LONG_SESSION_LAST_PROMPT : `Where is ${pick(SUBJECTS, index)} implemented?`;
  const t = startTurn(w, index, prompt);
  for (let i = 0; i < reads; i++) {
    const read = call(w, "Read");
    readCall(t, message(t, { calls: [read] }), read, pick(FILES, index + i));
  }
  const where = `${capitalise(t.subject)} lives in \`${t.file}\`; its tests are in \`tests/\`.`;
  const answer = last ? `${LONG_SESSION_LAST_ANSWER} ${where}` : where;
  message(t, { text: answer });
  finishTurn(t, answer, "completed");
}

/** Between turns, once the context passes the threshold: 1 item. */
function compaction(w: Writer): void {
  const compactionId = w.id("compaction");
  const before = w.contextUsed;
  w.emit("session.status", { ...STATUS_WORKING, message: "Compacting the conversation" }, 2_000);
  w.emit("compaction.started", {
    compactionId,
    trigger: "auto",
    turnId: null,
    contextUsed: before,
    contextWindow: CONTEXT_WINDOW,
    focus: null,
  });
  w.items += 1;
  const after = PREFIX_TOKENS + 6_400;
  w.emit(
    "compaction.finished",
    {
      compactionId,
      outcome: "completed",
      summary:
        "Working on the ledger app: rounding once per total, CSV import problems reported by line, the report's clock made replaceable. All tests pass.",
      contextBefore: before,
      contextAfter: after,
      error: null,
    },
    9_000,
  );
  w.contextUsed = after;
  w.emit("session.status", STATUS_IDLE);
}

/** Most items one call of `nextTurn` adds (a work turn whose first test run fails). */
const MAX_TURN_ITEMS = 12;

function nextTurn(w: Writer, index: number): void {
  if (w.contextUsed > compactAtFor(CONTEXT_WINDOW)) compaction(w);
  switch (index % 40) {
    case 9:
      permissionTurn(w, index, index % 80 !== 9);
      return;
    case 17:
      questionTurn(w, index);
      return;
    case 29:
      planTurn(w, index);
      return;
    case 23:
      interruptedTurn(w, index);
      return;
    case 35:
      shortTurn(w, index, 2);
      return;
    default:
      workTurn(w, index);
  }
}

/** The stored part: exactly `items` transcript items. */
export function longSessionEvents(items: number): EngineEvent[] {
  const w = new Writer();
  w.emit("session.updated", {
    title: LONG_SESSION_TITLE,
    mode: "default",
    model: MOCK_DEFAULT_MODEL_ID,
    modelInfo: null,
    effort: null,
    archived: false,
    additionalDirectories: [],
    changed: ["title"],
  });
  let index = 0;
  // Stop early enough that the last turn can make up the rest exactly (it needs at least 3).
  while (items - w.items >= MAX_TURN_ITEMS + 1 + 3) nextTurn(w, index++);
  const left = items - w.items;
  shortTurn(w, index, left - 3, true);
  return w.events;
}

/** The turn the next prompt plays: a long Markdown answer, streamed in small pieces. */
export function longSessionStream(after: EngineEvent | undefined): EngineEvent[] {
  const w = new Writer();
  w.time = (after?.payload.time ?? START_TIME) + 60_000;
  const turnId = "turn-stream";
  const messageId = "message-stream";
  w.emit("session.status", STATUS_WORKING);
  w.emit("turn.started", {
    turnId,
    prompt: { content: [{ type: "text", text: "Summarise the day's work." }], mentions: [] },
    command: null,
  });
  w.emit("message.started", { turnId, messageId }, 400);
  // One word per delta, about a token, until there are enough of them.
  const deltas: string[] = [];
  for (let i = 0; deltas.length < STREAM_DELTAS; i++) {
    const snippet = pick(SNIPPETS, i);
    const prose = pick(ANSWERS, i)(pick(SUBJECTS, i), pick(FILES, i), snippet).split("```")[0];
    const paragraph = `### ${capitalise(pick(SUBJECTS, i))}\n\n${prose}\n\n\`\`\`${snippet.language}\n${snippet.code}\n\`\`\`\n\n`;
    deltas.push(...(paragraph.match(/\S+\s*|\s+/g) ?? [paragraph]));
  }
  const text = deltas.join("");
  for (const delta of deltas) {
    w.emit("message.delta", { turnId, messageId, text: delta }, STREAM_GAP_MS);
  }
  w.emit("message.finished", { turnId, messageId, text, reasoning: null, toolCalls: [] }, 10);
  w.emit(
    "turn.finished",
    {
      turnId,
      stopReason: "completed",
      finalText: text,
      error: null,
      durationMs: w.time - (after?.payload.time ?? START_TIME),
    },
    10,
  );
  w.emit("session.status", STATUS_IDLE);
  return w.events;
}

/** The long session as a scenario for `createMockEngine`. */
export function longSessionScenario(items: number): LoadedScenario {
  const stored = longSessionEvents(items);
  const scenario: Scenario = {
    id: LONG_SESSION_ID,
    session: {
      title: LONG_SESSION_TITLE,
      cwd: LONG_SESSION_CWD,
      projectDir: LONG_SESSION_CWD,
      mode: "default",
      model: MOCK_DEFAULT_MODEL_ID,
      effort: null,
    },
    storedEndedAgoMs: 30_000,
    stored: "stored.jsonl",
    live: null,
    queuedBehind: null,
    branches: {},
    turns: ["stream.jsonl"],
  };
  return {
    scenario,
    recordings: { "stored.jsonl": stored, "stream.jsonl": longSessionStream(stored.at(-1)) },
  };
}
