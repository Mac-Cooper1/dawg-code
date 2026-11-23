/**
 * "Receipt PDF layout": the stored part ends mid-reply a few seconds before engine start, and
 * the live part finishes the turn within about 3 s, so the session shows as done and unread.
 */
import type { ScenarioDefinition } from "../define.ts";
import { Recordings, recorder, settings } from "../define.ts";
import { hunk } from "../text.ts";
import { callBash, callEdit, callReadRange, runBash, runEdit, runReadRange } from "../tools.ts";

const ID = "receipt-pdf";
const CWD = "~/code/tally";

/** Lines 44-71 of src/tally/pdf.py (96 lines). */
const PDF_LINES = [
  "def draw_lines(canvas: Canvas, receipt: Receipt, top: float) -> float:",
  '    """Draw one row per receipt line; returns the y below the last row."""',
  "    y = top",
  "    for line in receipt.lines:",
  "        y = draw_line(canvas, line, y)",
  "    return y",
  "",
  "",
  "def draw_line(canvas: Canvas, line: Line, y: float) -> float:",
  "    name = line.description",
  "    if line.quantity > 1:",
  '        name += f" x{line.quantity}"',
  "    canvas.setFont(BODY_FONT, BODY_SIZE)",
  "    canvas.drawString(MARGIN, y, name[:NAME_CHARS])",
  "    amount = format_amount(line.total, line.currency)",
  "    canvas.drawRightString(PAGE_WIDTH - MARGIN, y, amount)",
  "    return y - ROW_HEIGHT",
  "",
  "",
  "def draw_footer(canvas: Canvas, receipt: Receipt, y: float) -> None:",
  "    canvas.setFont(BOLD_FONT, BODY_SIZE)",
  '    canvas.drawString(MARGIN, y, "Total")',
  "    canvas.drawRightString(PAGE_WIDTH - MARGIN, y, format_amount(receipt.total(), receipt.currency))",
  "    y -= ROW_HEIGHT * 1.5",
  "    canvas.setFont(BODY_FONT, SMALL_SIZE)",
  "    for person, share in receipt.shares().items():",
  '        canvas.drawString(MARGIN, y, f"{person} pays {format_amount(share, receipt.currency)}")',
  "        y -= ROW_HEIGHT",
];

const WRAP_DIFF = hunk(52, 52, [
  " def draw_line(canvas: Canvas, line: Line, y: float) -> float:",
  "     name = line.description",
  "     if line.quantity > 1:",
  '         name += f" x{line.quantity}"',
  "     canvas.setFont(BODY_FONT, BODY_SIZE)",
  "-    canvas.drawString(MARGIN, y, name[:NAME_CHARS])",
  '+    rows = textwrap.wrap(name, NAME_CHARS, max_lines=2, placeholder="…") or [""]',
  "+    canvas.drawString(MARGIN, y, rows[0])",
  "     amount = format_amount(line.total, line.currency)",
  "     canvas.drawRightString(PAGE_WIDTH - MARGIN, y, amount)",
  "-    return y - ROW_HEIGHT",
  "+    for row in rows[1:]:",
  "+        y -= ROW_HEIGHT",
  "+        canvas.drawString(MARGIN + INDENT, y, row)",
  "+    return y - ROW_HEIGHT",
]);

const REPLY_START =
  "Long item names now wrap onto a second line, indented under the first, and the amount stays ";
const REPLY_END =
  "on the first line, right-aligned. A name that needs more than two lines ends with an ellipsis. The 6 PDF tests pass, and I added one with a 90-character name.";

export function receiptPdf(): ScenarioDefinition {
  const out = new Recordings();
  const rec = recorder({
    id: ID,
    cwd: CWD,
    seed: 53,
    settings: settings({ title: "Receipt PDF layout", mode: "acceptEdits" }),
  });

  rec.startTurn(
    "Long item names run off the edge of the receipt PDF. Wrap them onto a second line instead.",
  );
  let m = rec.message({ latencyMs: 1_200, completionExtra: 500 });
  const read = callReadRange(m, rec, "src/tally/pdf.py", 44, 28);
  m.end();
  runReadRange(rec, read, PDF_LINES, 96);
  m = rec.message({ extra: 2_400, latencyMs: 2_200, completionExtra: 900 });
  const edit = callEdit(m, rec, "src/tally/pdf.py", WRAP_DIFF);
  m.end();
  runEdit(rec, edit, WRAP_DIFF);
  m = rec.message({ extra: 1_600, latencyMs: 1_600, completionExtra: 400 });
  const test = callBash(m, "uv run pytest -q tests/test_pdf.py", "Run the PDF tests");
  m.end();
  runBash(rec, test, {
    output: "......                                                   [100%]\n6 passed in 1.12s\n",
    exitCode: 0,
    durationMs: 1_700,
  });
  m = rec.message({ extra: 900, latencyMs: 1_800, completionExtra: 300 });
  m.say(REPLY_START);
  out.add("stored.jsonl", rec);

  m.say(REPLY_END);
  m.end();
  rec.finishTurn();
  out.add("live.jsonl", rec);

  return {
    scenario: {
      id: ID,
      session: {
        title: "Receipt PDF layout",
        cwd: CWD,
        projectDir: CWD,
        mode: "acceptEdits",
        model: "qwen3.8-27b-q8",
        effort: null,
      },
      storedEndedAgoMs: 4_000,
      stored: "stored.jsonl",
      live: "live.jsonl",
      queuedBehind: null,
      branches: {},
      turns: [],
    },
    recordings: out.recordings,
    stats: out.stats,
  };
}
