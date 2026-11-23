/**
 * "Add tip support": waits on a question with three options. Each option, a free-text answer and
 * a dismissal continue differently.
 */
import type { DiffHunk, QuestionResponse } from "@dawg/protocol";
import { questionText } from "../../results.ts";
import type { ScenarioDefinition } from "../define.ts";
import { MINUTE, Recordings, recorder, settings } from "../define.ts";
import type { Recorder, ToolCall } from "../recorder.ts";
import { hunk } from "../text.ts";
import { callAsk, callBash, callEdit, callRead, runBash, runEdit, runRead } from "../tools.ts";
import { BILL_PY } from "./tally-files.ts";

const ID = "tip-support";
const CWD = "~/code/tally";
export const TIP_REQUEST = "request-tip-support-split";
const QUESTION = "How should the tip be shared?";
export const TIP_OPTIONS = [
  {
    label: "Evenly, with the bill",
    description: "Add the tip to the total, then split everything the same way",
  },
  { label: "By what each person ordered", description: "Each person tips on their own items" },
  {
    label: "Only among people who opt in",
    description: "Everyone else pays their share without a tip",
  },
] as const;
const FREE_TEXT = "Split it by what each person pays, so whoever ordered more tips more.";

const SIGNATURE = [
  "-def split_bill(bill: Bill, *, shared: bool = False) -> dict[str, Decimal]:",
  "+def split_bill(",
  "+    bill: Bill, *, shared: bool = False, tip_rate: Decimal = Decimal(0)",
  "+) -> dict[str, Decimal]:",
];

const EVENLY = hunk(34, 34, [
  ...SIGNATURE,
  '     """What each person owes.',
  " ",
  "     shared=True splits the whole bill evenly. Otherwise each item is split between the",
  "     people who ordered it, and the leftover cents go to whoever ordered first.",
  "+",
  "+    tip_rate (0.18 for 18%) is added to the bill, which is then split evenly.",
  '     """',
  "     if not bill.people:",
  "         return {}",
  "-    if shared:",
  "-        shares = split_evenly(bill.subtotal(), len(bill.people))",
  "+    if shared or tip_rate:",
  "+        total = to_cents(bill.subtotal() * (1 + tip_rate))",
  "+        shares = split_evenly(total, len(bill.people))",
  "         return dict(zip(bill.people, shares))",
]);

const BY_ITEM = hunk(34, 34, [
  ...SIGNATURE,
  '     """What each person owes.',
  " ",
  "     shared=True splits the whole bill evenly. Otherwise each item is split between the",
  "     people who ordered it, and the leftover cents go to whoever ordered first.",
  "+",
  "+    tip_rate (0.18 for 18%) is added to each item, so everyone tips on what they ordered.",
  '     """',
  "     if not bill.people:",
  "         return {}",
  "     if shared:",
  "         shares = split_evenly(bill.subtotal(), len(bill.people))",
  "         return dict(zip(bill.people, shares))",
  " ",
  "     owed: dict[str, Decimal] = defaultdict(Decimal)",
  "     for item in bill.items:",
  "-        parts = split_evenly(item.amount, len(item.ordered_by))",
  "+        with_tip = to_cents(item.amount * (1 + tip_rate))",
  "+        parts = split_evenly(with_tip, len(item.ordered_by))",
  "         for person, part in zip(item.ordered_by, parts):",
  "             owed[person] += part",
  "     return {person: to_cents(owed[person]) for person in bill.people}",
]);

const OPT_IN = hunk(34, 34, [
  "-def split_bill(bill: Bill, *, shared: bool = False) -> dict[str, Decimal]:",
  "+def split_bill(",
  "+    bill: Bill,",
  "+    *,",
  "+    shared: bool = False,",
  "+    tip_rate: Decimal = Decimal(0),",
  "+    tippers: tuple[str, ...] = (),",
  "+) -> dict[str, Decimal]:",
  '     """What each person owes.',
  " ",
  "     shared=True splits the whole bill evenly. Otherwise each item is split between the",
  "     people who ordered it, and the leftover cents go to whoever ordered first.",
  "+",
  "+    tip_rate (0.18 for 18%) of the whole bill is split evenly among `tippers`.",
  '     """',
  "     if not bill.people:",
  "         return {}",
  "     if shared:",
  "         shares = split_evenly(bill.subtotal(), len(bill.people))",
  "         return dict(zip(bill.people, shares))",
  " ",
  "     owed: dict[str, Decimal] = defaultdict(Decimal)",
  "     for item in bill.items:",
  "         parts = split_evenly(item.amount, len(item.ordered_by))",
  "         for person, part in zip(item.ordered_by, parts):",
  "             owed[person] += part",
  "+    if tip_rate and tippers:",
  "+        tip = to_cents(bill.subtotal() * tip_rate)",
  "+        for person, part in zip(tippers, split_evenly(tip, len(tippers))):",
  "+            owed[person] += part",
  "     return {person: to_cents(owed[person]) for person in bill.people}",
]);

function testHunk(name: string, call: string, expected: string): DiffHunk {
  return hunk(40, 41, [
    "+",
    "+",
    `+def ${name}():`,
    "+    bill = Bill()",
    '+    bill.add("pizza", Decimal("30.00"), "ana", "ben")',
    '+    bill.add("salad", Decimal("12.00"), "cy")',
    `+    owed = ${call}`,
    `+    assert owed == ${expected}`,
  ]);
}

const TESTS_LAST_LINE = '    assert describe({"ana": Decimal("5.00")}) == "ana      5.00"';

interface Variant {
  reply: string;
  billDiff: DiffHunk;
  testDiff: DiffHunk;
  done: string;
}

const EVENLY_VARIANT: Variant = {
  reply:
    "Got it. I’ll add a tip_rate argument to split_bill, add the tip to the total and split everything evenly, then update the receipt tests.",
  billDiff: EVENLY,
  testDiff: testHunk(
    "test_tip_is_added_then_split_evenly",
    'split_bill(bill, tip_rate=Decimal("0.18"))',
    '{"ana": Decimal("16.52"), "ben": Decimal("16.52"), "cy": Decimal("16.52")}',
  ),
  done: 'Done. `split_bill(bill, tip_rate=Decimal("0.18"))` adds the tip to the bill and splits the total evenly; without `tip_rate` nothing changes. I added a test for it, and all 24 tests pass.',
};

const BY_ITEM_VARIANT: Variant = {
  reply:
    "Got it. I’ll add a tip_rate argument to split_bill and apply it to each person’s items, then update the receipt tests.",
  billDiff: BY_ITEM,
  testDiff: testHunk(
    "test_tip_follows_what_each_person_ordered",
    'split_bill(bill, tip_rate=Decimal("0.18"))',
    '{"ana": Decimal("17.70"), "ben": Decimal("17.70"), "cy": Decimal("14.16")}',
  ),
  done: "Done. With `tip_rate`, each item is tipped before it is split between the people who ordered it, so everyone tips on their own items. I added a test; all 24 tests pass.",
};

const OPT_IN_VARIANT: Variant = {
  reply:
    "Got it. I’ll add tip_rate and a list of the people who opt in, so only they share the tip, then update the receipt tests.",
  billDiff: OPT_IN,
  testDiff: testHunk(
    "test_only_people_who_opt_in_share_the_tip",
    'split_bill(bill, tip_rate=Decimal("0.18"), tippers=("ana", "cy"))',
    '{"ana": Decimal("18.78"), "ben": Decimal("15.00"), "cy": Decimal("15.78")}',
  ),
  done: "Done. `split_bill` now takes `tip_rate` and `tippers`: the tip is split evenly among the people in `tippers`, and everyone else pays only for their items. I added a test; all 24 tests pass.",
};

const FREE_TEXT_VARIANT: Variant = {
  ...BY_ITEM_VARIANT,
  reply: "Got it. I’ll do it that way and update the receipt tests to match.",
  done: "Done. Each person now tips on what they ordered, so whoever ordered more tips more. I added a test; all 24 tests pass.",
};

/** The answer, then the edits, the test run and a closing line. */
function answer(rec: Recorder, ask: ToolCall, response: QuestionResponse, variant: Variant): void {
  rec.resolve({ kind: "question", requestId: TIP_REQUEST, response });
  rec.finishWaitingTool(ask, questionText(questionsOf(ask), response));
  let m = rec.message({ extra: 400, latencyMs: 1_700, completionExtra: 700 });
  m.say(variant.reply);
  const editBill = callEdit(m, rec, "src/tally/bill.py", variant.billDiff);
  m.end();
  runEdit(rec, editBill, variant.billDiff);
  m = rec.message({ extra: 600, latencyMs: 1_500, completionExtra: 500 });
  const editTests = callEdit(m, rec, "tests/test_bill.py", variant.testDiff, {
    before: TESTS_LAST_LINE,
    after: [TESTS_LAST_LINE, ...variant.testDiff.lines.map((l) => l.slice(1))].join("\n"),
  });
  m.end();
  runEdit(rec, editTests, variant.testDiff);
  m = rec.message({ extra: 300, latencyMs: 1_200, completionExtra: 200 });
  const test = callBash(m, "uv run pytest -q", "Run the test suite");
  m.end();
  runBash(rec, test, {
    output: `${".".repeat(24).padEnd(57)}[100%]\n24 passed in 0.31s\n`,
    exitCode: 0,
    durationMs: 900,
  });
  m = rec.message({ extra: 200, latencyMs: 1_400, completionExtra: 300 });
  m.say(variant.done);
  m.end();
  rec.finishTurn();
}

function questionsOf(call: ToolCall) {
  const questions = call.input.questions as {
    question: string;
    header?: string;
    options: { label: string; description?: string }[];
  }[];
  return questions.map((q) => ({ ...q, multiSelect: false }));
}

export function tipSupport(): ScenarioDefinition {
  const out = new Recordings();
  const rec = recorder({
    id: ID,
    cwd: CWD,
    seed: 37,
    settings: settings({ title: "Add tip support", mode: "acceptEdits" }),
  });

  rec.startTurn("Add tips to split_bill. People ask for it on every receipt.");
  let m = rec.message({ latencyMs: 1_300, completionExtra: 500 });
  const read = callRead(m, rec, "src/tally/bill.py");
  m.end();
  runRead(rec, read, BILL_PY);
  m = rec.message({ extra: 5_450, latencyMs: 2_600, completionExtra: 1_500 });
  m.say(
    "split_bill already knows who ordered what, so there are a few fair ways to share a tip. One decision before I write it:",
  );
  const ask = callAsk(m, [
    {
      question: QUESTION,
      header: "Tip split",
      options: TIP_OPTIONS.map((o) => ({ ...o })),
      multiSelect: false,
    },
  ]);
  m.end();
  rec.startTool(ask);
  rec.askQuestions(ask, TIP_REQUEST);
  out.add("stored.jsonl", rec);

  const branches: Record<string, string> = {};
  const variants: [string, Variant][] = [
    [TIP_OPTIONS[0].label, EVENLY_VARIANT],
    [TIP_OPTIONS[1].label, BY_ITEM_VARIANT],
    [TIP_OPTIONS[2].label, OPT_IN_VARIANT],
  ];
  variants.forEach(([label, variant], i) => {
    const branch = rec.fork();
    answer(
      branch,
      ask,
      { outcome: "answered", answers: [{ question: QUESTION, selected: [label] }] },
      variant,
    );
    branches[`answer:${label}`] = out.add(`answer-${i + 1}.jsonl`, branch);
  });

  const free = rec.fork();
  answer(
    free,
    ask,
    { outcome: "answered", answers: [{ question: QUESTION, selected: [], text: FREE_TEXT }] },
    FREE_TEXT_VARIANT,
  );
  branches.answer = out.add("answer-text.jsonl", free);

  const dismiss = rec.fork();
  const dismissed: QuestionResponse = { outcome: "dismissed" };
  dismiss.resolve({ kind: "question", requestId: TIP_REQUEST, response: dismissed });
  dismiss.finishWaitingTool(ask, questionText(questionsOf(ask), dismissed));
  m = dismiss.message({ extra: 200, latencyMs: 1_500, completionExtra: 400 });
  m.say("No problem. I’ll leave tips out and finish the rest; ask me again when you’ve decided.");
  m.end();
  dismiss.finishTurn();
  branches.dismiss = out.add("dismiss.jsonl", dismiss);

  return {
    scenario: {
      id: ID,
      session: {
        title: "Add tip support",
        cwd: CWD,
        projectDir: CWD,
        mode: "acceptEdits",
        model: "qwen3.8-27b-q8",
        effort: null,
      },
      storedEndedAgoMs: 9 * MINUTE,
      stored: "stored.jsonl",
      live: null,
      queuedBehind: null,
      branches: { [TIP_REQUEST]: branches },
      turns: [],
    },
    recordings: out.recordings,
    stats: out.stats,
  };
}
