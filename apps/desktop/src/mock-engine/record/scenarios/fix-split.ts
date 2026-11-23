/**
 * "Fix the failing split test": the main window of the mockup. Turn 1 is stored and finished,
 * turn 2 plays live from engine start, and turn 3 answers the next prompt (the mockup's queued
 * "Also update the README example.").
 */
import type { ScenarioDefinition } from "../define.ts";
import { Recordings, recorder, settings } from "../define.ts";
import type { RequestSpec } from "../recorder.ts";
import { hunk } from "../text.ts";
import {
  callBash,
  callEdit,
  callGrep,
  callRead,
  callTodo,
  runBash,
  runEdit,
  runGrep,
  runRead,
} from "../tools.ts";
import { MONEY_PY, README_MD } from "./tally-files.ts";

const ID = "fix-split";
const CWD = "~/code/tally/.dawg/worktrees/split-cents";

const OUT1 = [
  "..F.....                                                 [100%]",
  "============================== FAILURES ==============================",
  "_________________ test_split_evenly_keeps_every_cent _________________",
  "",
  "    def test_split_evenly_keeps_every_cent():",
  '        parts = split_evenly(Decimal("100.00"), 3)',
  '>       assert sum(parts) == Decimal("100.00")',
  "E       AssertionError: assert Decimal('99.99') == Decimal('100.00')",
  "",
  "tests/test_money.py:18: AssertionError",
  "FAILED tests/test_money.py::test_split_evenly_keeps_every_cent",
  "1 failed, 7 passed in 0.21s",
  "",
].join("\n");

const OUT2 = [
  "F                                                        [100%]",
  "E   assert [Decimal('-33.33'), Decimal('-33.33'), Decimal('-33.34')]",
  "E       == [Decimal('-33.34'), Decimal('-33.33'), Decimal('-33.33')]",
  "FAILED tests/test_money.py::test_split_evenly_refund_keeps_every_cent",
  "1 failed, 8 deselected in 0.18s",
  "",
].join("\n");

const DIFF1 = hunk(10, 10, [
  " def split_evenly(total: Decimal, parts: int) -> list[Decimal]:",
  '     """Split total into parts that add up to it exactly."""',
  "     if parts < 1:",
  '         raise ValueError("parts must be at least 1")',
  "-    share = (total / parts).quantize(CENT, rounding=ROUND_HALF_UP)",
  "-    return [share] * parts",
  "+    cents = int((total / CENT).to_integral_value())",
  "+    base, extra = divmod(cents, parts)",
  "+    return [",
  "+        (base + (1 if i < extra else 0)) * CENT",
  "+        for i in range(parts)",
  "+    ]",
]);

const DIFF2 = hunk(24, 25, [
  "+",
  "+def test_split_evenly_refund_keeps_every_cent():",
  '+    parts = split_evenly(Decimal("-100.00"), 3)',
  '+    assert sum(parts) == Decimal("-100.00")',
  '+    assert parts == [Decimal("-33.34"), Decimal("-33.33"), Decimal("-33.33")]',
]);
const TEST_LAST_LINE = '    assert parse_amount("$12.50") == Decimal("12.50")';

const DIFF3 = hunk(11, 11, [
  '     """Split total into parts that add up to it exactly."""',
  "     if parts < 1:",
  '         raise ValueError("parts must be at least 1")',
  "-    cents = int((total / CENT).to_integral_value())",
  "+    sign = -1 if total < 0 else 1",
  "+    cents = int((abs(total) / CENT).to_integral_value())",
  "     base, extra = divmod(cents, parts)",
  "     return [",
  "-        (base + (1 if i < extra else 0)) * CENT",
  "+        sign * (base + (1 if i < extra else 0)) * CENT",
  "         for i in range(parts)",
  "     ]",
]);

const README_DIFF = hunk(14, 14, [
  " from decimal import Decimal",
  " from tally.money import split_evenly",
  " ",
  '-split_evenly(Decimal("100.00"), 3)',
  "-# [Decimal('33.33'), Decimal('33.33'), Decimal('33.33')]",
  "-# Each share is rounded, so the parts can come to 99.99.",
  "+split_evenly(Decimal(\"100.00\"), 3)   # [Decimal('33.34'), Decimal('33.33'), Decimal('33.33')]",
  '+split_evenly(Decimal("-100.00"), 3)  # a refund mirrors it: -33.34, -33.33, -33.33',
  "+# The first shares take the leftover cents, so the parts always add up.",
  " ```",
  " ",
  " ## Receipts",
]);

const TASKS = [
  { content: "Add tests for refunds (negative totals)", activeForm: "Adding tests for refunds" },
  {
    content: "Make split_evenly handle negative totals",
    activeForm: "Making split_evenly handle negative totals",
  },
  { content: "Run the whole test suite", activeForm: "Running the whole test suite" },
] as const;

/** The task list with the first `done` tasks completed and the next one in progress. */
function tasks(done: number) {
  return TASKS.map((t, i) => ({
    ...t,
    status:
      i < done
        ? ("completed" as const)
        : i === done
          ? ("in_progress" as const)
          : ("pending" as const),
  }));
}

/**
 * Request figures, tuned so the turns read as in the design: turn 1 about 48 s with 6 requests
 * and 92% of the prompt from cache, turn 2 about 1 min 12 s with 9 requests and 94% cached,
 * ending near 74,200 tokens of context. `extra` is uncached input (tool results, notes);
 * `completionExtra` is reasoning the recording does not stream.
 */
function turn1(latencyMs: number): RequestSpec {
  return { extra: 1_750, completionExtra: 1_450, latencyMs: latencyMs + 1_500 };
}

function turn2(latencyMs: number): RequestSpec {
  return { extra: 3_000, completionExtra: 1_190, latencyMs: latencyMs + 1_100 };
}

export function fixSplit(): ScenarioDefinition {
  const out = new Recordings();
  const rec = recorder({
    id: ID,
    cwd: CWD,
    seed: 11,
    settings: settings({
      title: "Fix the failing split test",
      mode: "acceptEdits",
      effort: "xhigh",
    }),
  });

  // Turn 1, stored: find the failure, fix it, run the tests.
  rec.startTurn(
    "The test suite fails on `test_split_evenly_keeps_every_cent`. Fix it without changing the test.",
  );
  let m = rec.message({ ...turn1(900), extra: 0 });
  m.think(
    "The test wants three parts that add up to 100.00. Rounding each share to the cent gives 33.33 three times, which is 99.99, so the leftover cent has to go somewhere. Run the tests first to see the exact failure, then read money.py.",
    { durationMs: 5_000 },
  );
  const test1 = callBash(m, "uv run pytest -q", "Run the test suite");
  m.end();
  runBash(rec, test1, { output: OUT1, exitCode: 1, durationMs: 900 });

  m = rec.message(turn1(2_600));
  const read = callRead(m, rec, "src/tally/money.py");
  m.end();
  runRead(rec, read, MONEY_PY);

  m = rec.message(turn1(3_400));
  const grep = callGrep(m, "split_evenly", { output_mode: "content" });
  m.end();
  runGrep(rec, grep, [
    {
      file: "src/tally/money.py",
      line: 10,
      text: "def split_evenly(total: Decimal, parts: int) -> list[Decimal]:",
    },
    {
      file: "src/tally/bill.py",
      line: 7,
      text: "from tally.money import CENT, split_evenly, sum_amounts, to_cents",
    },
    {
      file: "src/tally/bill.py",
      line: 43,
      text: "        shares = split_evenly(bill.subtotal(), len(bill.people))",
    },
    {
      file: "src/tally/bill.py",
      line: 48,
      text: "        parts = split_evenly(item.amount, len(item.ordered_by))",
    },
    {
      file: "tests/test_money.py",
      line: 4,
      text: "from tally.money import format_amount, parse_amount, split_evenly",
    },
    {
      file: "tests/test_money.py",
      line: 17,
      text: '    parts = split_evenly(Decimal("100.00"), 3)',
    },
  ]);

  m = rec.message(turn1(4_100));
  const edit1 = callEdit(m, rec, "src/tally/money.py", DIFF1);
  m.end();
  runEdit(rec, edit1, DIFF1);

  m = rec.message(turn1(2_200));
  const test2 = callBash(m, "uv run pytest -q", "Run the test suite");
  m.end();
  runBash(rec, test2, {
    output: "........                                                 [100%]\n8 passed in 0.19s\n",
    exitCode: 0,
    durationMs: 800,
  });

  m = rec.message(turn1(2_500));
  m.say(
    "Fixed. `split_evenly` rounded every share to the cent, so three shares of 100.00 came to 99.99. It now works in whole cents and hands the leftover cents to the first shares: 33.34, 33.33, 33.33. All 8 tests pass.",
  );
  m.end();
  rec.finishTurn();
  out.add("stored.jsonl", rec);

  // Turn 2, live: refunds.
  rec.pause(1_200, 1_600);
  rec.startTurn(
    "Nice. Negative totals should split the same way, for refunds. Add tests for that too.",
  );
  m = rec.message(turn2(1_800));
  const todo1 = callTodo(m, tasks(0));
  m.end();
  rec.runTodo(todo1);

  m = rec.message(turn2(2_200));
  const edit2 = callEdit(m, rec, "tests/test_money.py", DIFF2, {
    before: TEST_LAST_LINE,
    after: [TEST_LAST_LINE, ...DIFF2.lines.map((l) => l.slice(1))].join("\n"),
  });
  m.end();
  runEdit(rec, edit2, DIFF2);

  m = rec.message(turn2(1_400));
  const todo2 = callTodo(m, tasks(1));
  m.end();
  rec.runTodo(todo2);

  m = rec.message(turn2(1_600));
  const test3 = callBash(m, "uv run pytest -q -k refund", "Run the refund test");
  m.end();
  runBash(rec, test3, { output: OUT2, exitCode: 1, durationMs: 700 });

  m = rec.message(turn2(2_400));
  m.say(
    "The sum is right, but the extra cent lands on the last share instead of the first: `divmod` rounds toward minus infinity, so −10,000 cents split three ways gives −3,334 with 2 left over. I'll split the absolute amount and put the sign back, so a refund mirrors the charge exactly.",
  );
  const edit3 = callEdit(m, rec, "src/tally/money.py", DIFF3);
  m.end();
  runEdit(rec, edit3, DIFF3);

  m = rec.message(turn2(1_500));
  const todo3 = callTodo(m, tasks(2));
  m.end();
  rec.runTodo(todo3);

  m = rec.message(turn2(1_700));
  const test4 = callBash(m, "uv run pytest -q", "Run the whole test suite");
  m.end();
  runBash(rec, test4, {
    output: "..........                                               [100%]\n10 passed in 0.21s\n",
    exitCode: 0,
    durationMs: 800,
  });

  m = rec.message(turn2(1_300));
  const todo4 = callTodo(m, tasks(3));
  m.end();
  rec.runTodo(todo4);

  m = rec.message(turn2(1_900));
  m.say(
    "Refunds now mirror charges: −100.00 splits into −33.34, −33.33, −33.33. All 10 tests pass.",
  );
  m.end();
  rec.finishTurn();
  out.add("live.jsonl", rec);

  // Turn 3, on the next prompt: the README example. The mockup shows its slow first read.
  rec.pause(2_000, 3_000);
  rec.startTurn("Also update the README example.");
  m = rec.message({ prompt: { total: 24_410, cached: 14_080 }, promptTps: 1_240, progress: true });
  const readme = callRead(m, rec, "README.md");
  m.end();
  runRead(rec, readme, README_MD);

  m = rec.message({ latencyMs: 1_200 });
  const edit4 = callEdit(m, rec, "README.md", README_DIFF);
  m.end();
  runEdit(rec, edit4, README_DIFF);

  m = rec.message({ latencyMs: 900 });
  m.say(
    "Updated the README example: it now shows a refund split as well, and says that the first shares take the leftover cents.",
  );
  m.end();
  rec.finishTurn();
  out.add("turn-3.jsonl", rec);

  return {
    scenario: {
      id: ID,
      session: {
        title: "Fix the failing split test",
        cwd: CWD,
        projectDir: "~/code/tally",
        mode: "acceptEdits",
        model: "qwen3.8-27b-q8",
        effort: "xhigh",
      },
      storedEndedAgoMs: 0,
      stored: "stored.jsonl",
      live: "live.jsonl",
      queuedBehind: null,
      branches: {},
      turns: ["turn-3.jsonl"],
    },
    recordings: out.recordings,
    stats: out.stats,
  };
}
