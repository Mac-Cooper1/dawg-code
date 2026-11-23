/**
 * "Multi-currency totals": plan mode, waiting on plan approval. Approving into Accept edits
 * carries the plan out; approving back into Ask first stops at a permission request for the
 * first edit; keeping planning revises the plan and proposes it again.
 */
import type { PermissionMode, PlanResponse } from "@dawg/protocol";
import { deniedText, planText } from "../../results.ts";
import type { ScenarioDefinition } from "../define.ts";
import { MINUTE, Recordings, recorder, settings } from "../define.ts";
import type { Recorder, ToolCall } from "../recorder.ts";
import { diffDisplay, hunk } from "../text.ts";
import {
  callBash,
  callEdit,
  callGrep,
  callPlan,
  callRead,
  callWrite,
  runBash,
  runEdit,
  runGrep,
  runRead,
  runWrite,
} from "../tools.ts";
import { RECEIPT_PY } from "./receipt-py.ts";

const ID = "multi-currency";
const CWD = "~/code/tally/.dawg/worktrees/multi-currency";
const PLAN_PATH = "~/.dawg/plans/multi-currency-totals.md";
export const PLAN_REQUEST = "request-multi-currency-plan";
export const EDIT_REQUEST = "request-multi-currency-edit";
export const REVISED_PLAN_REQUEST = "request-multi-currency-plan-2";
const FEEDBACK = "Read rates from the ECB daily file instead of a JSON file in the repo.";

const PLAN = [
  "### Goal",
  "",
  "Receipt totals come out in the receipt’s home currency, even when lines mix currencies.",
  "",
  "### Steps",
  "",
  "1. Add a `Money` type (amount and currency) to `money.py`; the Decimal helpers keep working.",
  "2. Add `rates.py`: a rates table read from `rates.json`. No network calls.",
  "3. Convert each line in `Receipt.total()` and round once, at the end.",
  "4. Tests: a mixed-currency receipt, a missing rate, and rounding that stays within one cent.",
  "",
  "### Not changing",
  "",
  "The CSV import format and the PDF layout.",
].join("\n");

const REVISED_PLAN = [
  "### Goal",
  "",
  "Receipt totals come out in the receipt’s home currency, even when lines mix currencies.",
  "",
  "### Steps",
  "",
  "1. Add a `Money` type (amount and currency) to `money.py`; the Decimal helpers keep working.",
  "2. Add `rates.py`: fetch the ECB daily reference rates (`eurofxref-daily.xml`) once a day and cache the file for that day. Tests use a saved copy and never touch the network.",
  "3. Convert each line in `Receipt.total()` and round once, at the end.",
  "4. Tests: a mixed-currency receipt, a missing rate, a stale cache, and rounding that stays within one cent.",
  "",
  "### Not changing",
  "",
  "The CSV import format and the PDF layout.",
].join("\n");

/** The 1-based line number of the `nth` (0-based) line of receipt.py equal to `text`. */
function lineOf(text: string, nth = 0): number {
  let index = -1;
  for (let found = -1; found < nth; found++) {
    index = RECEIPT_PY.indexOf(text, index + 1);
    if (index < 0) throw new Error(`receipt.py has no line ${JSON.stringify(text)}`);
  }
  return index + 1;
}

const MONEY_DIFF = hunk(1, 1, [
  "+from dataclasses import dataclass",
  " from decimal import Decimal, ROUND_HALF_UP",
  " ",
  ' CENT = Decimal("0.01")',
  " ",
  "+",
  "+@dataclass(frozen=True)",
  "+class Money:",
  '+    """An amount in a currency. The Decimal helpers below keep working on plain amounts."""',
  "+",
  "+    amount: Decimal",
  "+    currency: str",
  "+",
  '+    def rounded(self) -> "Money":',
  "+        return Money(to_cents(self.amount), self.currency)",
  "+",
  " ",
  " def to_cents(amount: Decimal) -> Decimal:",
]);

const RATES_PY = [
  '"""Exchange rates, read from rates.json next to this file. No network calls."""',
  "",
  "import json",
  "from decimal import Decimal",
  "from pathlib import Path",
  "",
  'RATES_FILE = Path(__file__).with_name("rates.json")',
  "",
  "",
  "class MissingRate(LookupError):",
  "    def __init__(self, source: str, target: str):",
  '        super().__init__(f"no rate from {source} to {target} in {RATES_FILE.name}")',
  "",
  "",
  "def load_rates(path: Path = RATES_FILE) -> dict[str, Decimal]:",
  '    """Rates against the euro, for example {"USD": Decimal("1.0842")}."""',
  "    raw = json.loads(path.read_text())",
  '    rates = {code: Decimal(str(rate)) for code, rate in raw["rates"].items()}',
  '    return rates | {"EUR": Decimal(1)}',
  "",
  "",
  "def convert(",
  "    amount: Decimal, source: str, target: str, rates: dict[str, Decimal] | None = None",
  ") -> Decimal:",
  '    """The amount in `target`, unrounded: callers round once, at the end."""',
  "    if source == target:",
  "        return amount",
  "    rates = rates if rates is not None else load_rates()",
  "    try:",
  "        return amount / rates[source] * rates[target]",
  "    except KeyError:",
  "        raise MissingRate(source, target) from None",
  "",
].join("\n");

const RECEIPT_IMPORT_DIFF = hunk(9, 9, [
  " from tally.money import format_amount, split_evenly, sum_amounts, to_cents",
  "+from tally.rates import convert",
]);

// After the import edit, one line further down.
const SUBTOTAL = lineOf("    def subtotal(self) -> Decimal:") + 1;
const RECEIPT_TOTAL_DIFF = hunk(SUBTOTAL, SUBTOTAL, [
  "     def subtotal(self) -> Decimal:",
  "-        # Every line is assumed to be in the receipt's currency.",
  "-        return sum_amounts([line.total for line in self.lines])",
  '+        """Every line in the receipt\'s currency, rounded once at the end."""',
  "+        converted = [convert(line.total, line.currency, self.currency) for line in self.lines]",
  "+        return to_cents(sum(converted, Decimal(0)))",
]);

const TESTS_PASS = `${".".repeat(24).padEnd(57)}[100%]\n24 passed in 0.33s\n`;

/** Answers the plan: `request.resolved`, the mode change on approval, the tool's result. */
function answerPlan(
  rec: Recorder,
  call: ToolCall,
  requestId: string,
  response: PlanResponse,
  mode: PermissionMode | null,
): void {
  rec.resolve({ kind: "plan", requestId, response });
  if (mode !== null) rec.updateSettings({ mode });
  rec.finishWaitingTool(call, planText(response, mode ?? "plan"));
}

export function multiCurrency(): ScenarioDefinition {
  const out = new Recordings();
  const rec = recorder({
    id: ID,
    cwd: CWD,
    seed: 41,
    settings: settings({ title: "Multi-currency totals", mode: "default" }),
  });

  rec.updateSettings({ mode: "plan" });
  rec.pause(4_000, 6_000);
  rec.startTurn(
    "Receipts can mix currencies now. Totals should come out in the receipt’s home currency. Plan it first.",
  );
  let m = rec.message({ latencyMs: 1_600, completionExtra: 900 });
  m.think(
    "Find everything that touches currency first: the receipt model, formatting, the CSV import and the PDF.",
  );
  const grep = callGrep(m, "currency", { output_mode: "content" });
  m.end();
  runGrep(rec, grep, [
    {
      file: "src/tally/receipt.py",
      line: lineOf('    currency: str = "USD"'),
      text: '    currency: str = "USD"',
    },
    {
      file: "src/tally/receipt.py",
      line: lineOf('    currency: str = "USD"', 1),
      text: '    currency: str = "USD"',
    },
    {
      file: "src/tally/receipt.py",
      line: lineOf("        currency: str | None = None,"),
      text: "        currency: str | None = None,",
    },
    {
      file: "src/tally/receipt.py",
      line: lineOf("        # Every line is assumed to be in the receipt's currency."),
      text: "        # Every line is assumed to be in the receipt's currency.",
    },
    {
      file: "src/tally/receipt.py",
      line: lineOf("        return {line.currency for line in self.lines}"),
      text: "        return {line.currency for line in self.lines}",
    },
    {
      file: "src/tally/receipt.py",
      line: lineOf("    if first.currency != second.currency:"),
      text: "    if first.currency != second.currency:",
    },
    {
      file: "src/tally/money.py",
      line: 18,
      text: 'def format_amount(amount: Decimal, currency: str = "USD") -> str:',
    },
    {
      file: "src/tally/money.py",
      line: 20,
      text: '    symbol = SYMBOLS.get(currency, currency + " ")',
    },
    { file: "src/tally/csv_import.py", line: 18, text: "    currency: str" },
    {
      file: "src/tally/csv_import.py",
      line: 37,
      text: '        currency=record["currency"].upper(),',
    },
    {
      file: "src/tally/pdf.py",
      line: 58,
      text: "    amount = format_amount(line.total, line.currency)",
    },
    {
      file: "tests/test_csv_import.py",
      line: 8,
      text: 'HEADER = ["date", "description", "amount", "currency", "paid_by"]',
    },
    {
      file: "tests/test_csv_import.py",
      line: 25,
      text: '                             currency="USD", paid_by="sam")',
    },
    {
      file: "tests/test_receipt.py",
      line: 12,
      text: '    receipt = Receipt("Cafe Lumen", date(2026, 11, 2), currency="EUR")',
    },
  ]);
  m = rec.message({ extra: 6_200, latencyMs: 2_300, completionExtra: 1_200 });
  const read = callRead(m, rec, "src/tally/receipt.py");
  m.end();
  runRead(rec, read, RECEIPT_PY);
  m = rec.message({ extra: 11_800, latencyMs: 3_100, completionExtra: 4_000 });
  const plan = callPlan(m, PLAN);
  m.end();
  rec.startTool(plan);
  rec.proposePlan(plan, PLAN_REQUEST, PLAN_PATH);
  out.add("stored.jsonl", rec);

  // Approved into Accept edits: carry the plan out.
  const edits = rec.fork();
  answerPlan(
    edits,
    plan,
    PLAN_REQUEST,
    { decision: "approve", mode: "acceptEdits" },
    "acceptEdits",
  );
  m = edits.message({ extra: 200, latencyMs: 1_800, completionExtra: 600 });
  m.say("Starting with the Money type in money.py.");
  const money = callEdit(m, edits, "src/tally/money.py", MONEY_DIFF);
  m.end();
  runEdit(edits, money, MONEY_DIFF);
  m = edits.message({ extra: 300, latencyMs: 1_500, completionExtra: 400 });
  const rates = callWrite(m, edits, "src/tally/rates.py", RATES_PY);
  m.end();
  runWrite(edits, rates);
  carryOutReceipt(edits);
  out.add("approve-accept-edits.jsonl", edits);

  // Approved back into Ask first: the first edit asks for permission.
  const ask = rec.fork();
  answerPlan(ask, plan, PLAN_REQUEST, { decision: "approve" }, "default");
  m = ask.message({ extra: 200, latencyMs: 1_800, completionExtra: 600 });
  m.say("Starting with the Money type in money.py.");
  const askedEdit = callEdit(m, ask, "src/tally/money.py", MONEY_DIFF);
  m.end();
  ask.startTool(askedEdit);
  ask.requestPermission(askedEdit, {
    requestId: EDIT_REQUEST,
    title: "Edit a file",
    reason: "Ask first mode asks before every edit, and no rule allows editing src/tally/money.py.",
    suggestions: ["Edit(src/tally/**)"],
    display: diffDisplay(String(askedEdit.input.file_path), [MONEY_DIFF]),
  });
  out.add("approve.jsonl", ask);

  const allowed = ask.fork();
  allowed.resolve({
    kind: "permission",
    requestId: EDIT_REQUEST,
    response: { behavior: "allow", scope: "once" },
  });
  runEdit(allowed, askedEdit, MONEY_DIFF, { start: false });
  m = allowed.message({ extra: 300, latencyMs: 1_400, completionExtra: 300 });
  const check = callBash(m, "uv run pytest -q", "Run the test suite");
  m.end();
  runBash(allowed, check, { output: TESTS_PASS, exitCode: 0, durationMs: 950 });
  m = allowed.message({ extra: 200, latencyMs: 1_500, completionExtra: 400 });
  m.say(
    "`Money` is in money.py and the 24 existing tests still pass. Next are `rates.py` and the conversion in `Receipt.total()`; each edit asks first while the session is in Ask first mode.",
  );
  m.end();
  allowed.finishTurn();
  out.add("approve-edit-allow.jsonl", allowed);

  const denied = ask.fork();
  denied.resolve({ kind: "permission", requestId: EDIT_REQUEST, response: { behavior: "deny" } });
  denied.denyTool(askedEdit, deniedText("Edit"));
  m = denied.message({ extra: 200, latencyMs: 1_500, completionExtra: 300 });
  m.say(
    "All right, I’ve left money.py alone. Tell me where you’d rather the Money type live, or switch to Accept edits if you want me to carry out the plan as written.",
  );
  m.end();
  denied.finishTurn();
  out.add("approve-edit-deny.jsonl", denied);

  // Keep planning, with feedback: a revised plan, proposed again.
  const revise = rec.fork();
  answerPlan(revise, plan, PLAN_REQUEST, { decision: "reject", message: FEEDBACK }, null);
  m = revise.message({ extra: 300, latencyMs: 2_000, completionExtra: 1_100 });
  m.say("Fair. I’ll read the ECB daily file instead, cache it for the day, and update the plan.");
  const revised = callPlan(m, REVISED_PLAN);
  m.end();
  revise.startTool(revised);
  revise.proposePlan(revised, REVISED_PLAN_REQUEST, PLAN_PATH);
  out.add("reject.jsonl", revise);

  const revisedApproved = revise.fork();
  answerPlan(revisedApproved, revised, REVISED_PLAN_REQUEST, { decision: "approve" }, "default");
  m = revisedApproved.message({ extra: 200, latencyMs: 1_300, completionExtra: 300 });
  m.say(
    "Plan approved and saved. I’ll start with the Money type in money.py; send a message when you want me to go ahead.",
  );
  m.end();
  revisedApproved.finishTurn();
  out.add("reject-approve.jsonl", revisedApproved);

  const revisedRejected = revise.fork();
  answerPlan(revisedRejected, revised, REVISED_PLAN_REQUEST, { decision: "reject" }, null);
  m = revisedRejected.message({ extra: 200, latencyMs: 1_300, completionExtra: 300 });
  m.say("Understood. Tell me what else should change and I’ll revise the plan again.");
  m.end();
  revisedRejected.finishTurn();
  out.add("reject-reject.jsonl", revisedRejected);

  return {
    scenario: {
      id: ID,
      session: {
        title: "Multi-currency totals",
        cwd: CWD,
        projectDir: "~/code/tally",
        mode: "default",
        model: "qwen3.8-27b-q8",
        effort: null,
      },
      storedEndedAgoMs: 21 * MINUTE,
      stored: "stored.jsonl",
      live: null,
      queuedBehind: null,
      branches: {
        [PLAN_REQUEST]: {
          "approve:acceptEdits": "approve-accept-edits.jsonl",
          approve: "approve.jsonl",
          reject: "reject.jsonl",
        },
        [EDIT_REQUEST]: { allow: "approve-edit-allow.jsonl", deny: "approve-edit-deny.jsonl" },
        [REVISED_PLAN_REQUEST]: { approve: "reject-approve.jsonl", reject: "reject-reject.jsonl" },
      },
      turns: [],
    },
    recordings: out.recordings,
    stats: out.stats,
  };
}

/** The receipt part of the plan, in Accept edits: the import and the conversion, then tests. */
function carryOutReceipt(rec: Recorder): void {
  const m = rec.message({ extra: 400, latencyMs: 1_700, completionExtra: 700 });
  const importEdit = callEdit(m, rec, "src/tally/receipt.py", RECEIPT_IMPORT_DIFF, {
    before: "from tally.money import format_amount, split_evenly, sum_amounts, to_cents",
    after: [
      "from tally.money import format_amount, split_evenly, sum_amounts, to_cents",
      "from tally.rates import convert",
    ].join("\n"),
  });
  const totalEdit = callEdit(m, rec, "src/tally/receipt.py", RECEIPT_TOTAL_DIFF);
  m.end();
  runEdit(rec, importEdit, RECEIPT_IMPORT_DIFF);
  runEdit(rec, totalEdit, RECEIPT_TOTAL_DIFF);
  const m2 = rec.message({ extra: 300, latencyMs: 1_300, completionExtra: 300 });
  const test = callBash(m2, "uv run pytest -q", "Run the test suite");
  m2.end();
  runBash(rec, test, { output: TESTS_PASS, exitCode: 0, durationMs: 950 });
  const m3 = rec.message({ extra: 200, latencyMs: 1_600, completionExtra: 500 });
  m3.say(
    "Done with the code: `Money` is in money.py, `rates.py` reads `rates.json`, and `Receipt.subtotal()` converts every line to the receipt’s currency and rounds once at the end, so `total()` follows. The 24 existing tests pass; the mixed-currency, missing-rate and rounding tests from step 4 are next.",
  );
  m3.end();
  rec.finishTurn();
}
