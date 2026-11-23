/**
 * "Flaky CSV import test": waits on permission to run `uv add --dev pytest-repeat`. Allowing it
 * runs the test 50 times with live output and finds the race; denying it gets a shell loop.
 */
import { deniedText } from "../../results.ts";
import type { ScenarioDefinition } from "../define.ts";
import { MINUTE, Recordings, recorder, settings } from "../define.ts";
import type { ToolProgressStep } from "../recorder.ts";
import { callBash, callRead, runBash, runRead } from "../tools.ts";
import { CSV_IMPORT_PY, TEST_CSV_IMPORT_PY } from "./tally-files.ts";

const ID = "flaky-csv";
const CWD = "~/code/tally";
export const FLAKY_CSV_REQUEST = "request-flaky-csv-uv-add";
const DENY_NOTE = "Don’t add dependencies. Loop it in the shell instead.";

const UV_ADD_OUTPUT = [
  "Resolved 14 packages in 212ms",
  "Prepared 1 package in 388ms",
  "Installed 1 package in 6ms",
  " + pytest-repeat==0.9.4",
  "",
].join("\n");

/** 300 test runs (6 tests × 50), one failure at run 176, as pytest -q prints them. */
function repeatOutput(): { output: string; progress: ToolProgressStep[] } {
  const total = 300;
  const failAt = 176;
  const durationMs = 11_840;
  const progress: ToolProgressStep[] = [];
  let output = "";
  let chunk = "";
  let lineLength = 0;
  for (let i = 1; i <= total; i++) {
    chunk += i === failAt ? "F" : ".";
    lineLength += 1;
    if (lineLength === 80 || i === total) {
      const pct = String(Math.round((i / total) * 100)).padStart(3);
      chunk += `${" ".repeat(80 - lineLength)} [${pct}%]\n`;
      lineLength = 0;
    }
    const at = Math.round((i / total) * (durationMs - 300));
    if (i % 6 === 0 || i === total) {
      progress.push({ at, output: chunk });
      output += chunk;
      chunk = "";
    }
    if (i % 12 === 0 && i < total) {
      const failures = i >= failAt ? " · 1 failure so far" : "";
      progress.push({ at: at + 1, status: `${i / 6} of 50 runs${failures}` });
    }
  }
  const tail = [
    "=================================== FAILURES ===================================",
    "_____________________ test_import_keeps_row_order[26-50] ______________________",
    "",
    "tmp_path = PosixPath('/private/var/folders/x1/T/pytest-of-sam/pytest-212/test_import_keeps_row_order_26_0')",
    "",
    "    def test_import_keeps_row_order(tmp_path):",
    "        path = write_rows(tmp_path, 1_024)",
    "        rows = import_csv(path)",
    "        assert len(rows) == 1_024",
    ">       assert [r.line for r in rows] == list(range(2, 1_026))",
    "E       assert [1002, 1003, 1004, 1005, 1006, 1007, ...] == [2, 3, 4, 5, 6, 7, ...]",
    "E         ",
    "E         At index 0 diff: 1002 != 2",
    "E         Use -v to get more diff",
    "",
    "tests/test_csv_import.py:46: AssertionError",
    "=========================== short test summary info ============================",
    "FAILED tests/test_csv_import.py::test_import_keeps_row_order[26-50] - assert [1002, 1003, ...",
    "1 failed, 299 passed in 11.84s",
    "",
  ].join("\n");
  progress.push({ at: durationMs - 80, output: tail });
  return { output: output + tail, progress };
}

export function flakyCsv(): ScenarioDefinition {
  const out = new Recordings();
  const rec = recorder({
    id: ID,
    cwd: CWD,
    seed: 23,
    settings: settings({ title: "Flaky CSV import test", mode: "default" }),
  });

  rec.startTurn("tests/test_csv_import.py fails about one run in five on CI. Find out why.");
  let m = rec.message({ latencyMs: 1_400, completionExtra: 600 });
  const read = callRead(m, rec, "tests/test_csv_import.py");
  m.end();
  runRead(rec, read, TEST_CSV_IMPORT_PY);

  m = rec.message({ extra: 5_100, latencyMs: 2_100, completionExtra: 2_200 });
  m.say(
    "Nothing in the test is obviously order-dependent, so I'll run it many times to catch a failure. That needs the pytest-repeat plugin, which this project doesn't have yet.",
  );
  const add = callBash(
    m,
    "uv add --dev pytest-repeat",
    "Add pytest-repeat as a development dependency",
  );
  m.end();
  rec.startTool(add);
  rec.requestPermission(add, {
    requestId: FLAKY_CSV_REQUEST,
    title: "Run a shell command",
    reason:
      "Adds a development dependency: changes pyproject.toml and uv.lock and downloads a package from PyPI. No rule allows `uv add` in this project.",
    suggestions: ["Bash(uv add --dev *)"],
  });
  out.add("stored.jsonl", rec);

  // Allowed (once or always): add the plugin, run the test 50 times, read the importer.
  const allow = rec.fork();
  allow.resolve({
    kind: "permission",
    requestId: FLAKY_CSV_REQUEST,
    response: { behavior: "allow", scope: "once" },
  });
  runBash(allow, add, { output: UV_ADD_OUTPUT, exitCode: 0, durationMs: 1_400, start: false });
  m = allow.message({ extra: 600, latencyMs: 1_600 });
  const repeat = callBash(
    m,
    "uv run pytest tests/test_csv_import.py --count 50 -q",
    "Run the CSV import tests 50 times",
  );
  m.end();
  const repeated = repeatOutput();
  runBash(allow, repeat, {
    output: repeated.output,
    exitCode: 1,
    durationMs: 11_840,
    progress: repeated.progress,
  });
  m = allow.message({ extra: 900, latencyMs: 2_400, completionExtra: 800 });
  m.think(
    "Index 0 is line 1002: the second chunk's rows came first. 1,024 rows is just over one chunk of 1,000, so check how import_csv joins the chunks.",
  );
  const importer = callRead(m, allow, "src/tally/csv_import.py");
  m.end();
  runRead(allow, importer, CSV_IMPORT_PY);
  m = allow.message({ extra: 300, latencyMs: 2_800, completionExtra: 900 });
  m.say(
    [
      "Found it. `import_csv` parses the file on a thread pool, 1,000 rows per chunk, and appends each chunk's rows as soon as that chunk finishes (`as_completed`). The test writes 1,024 rows, just over one chunk, so the second chunk has only 24 rows. It usually finishes last, but now and then it wins the race and its rows land first: here that happened once in 50 runs, and CI machines, slower and busier, hit it more often.",
      "",
      "The fix is `executor.map`, which returns the results in the order the chunks were submitted:",
      "",
      "```python",
      "with ThreadPoolExecutor(max_workers=WORKERS) as executor:",
      "    for chunk_rows in executor.map(_parse_chunk, _chunks(path)):",
      "        rows.extend(chunk_rows)",
      "```",
      "",
      "Want me to make that change and run the 50 repeats again to confirm?",
    ].join("\n"),
  );
  m.end();
  allow.finishTurn();
  out.add("allow.jsonl", allow);

  // Denied with a note: no new dependency; offer a shell loop instead.
  const deny = rec.fork();
  deny.resolve({
    kind: "permission",
    requestId: FLAKY_CSV_REQUEST,
    response: { behavior: "deny", message: DENY_NOTE },
  });
  deny.denyTool(add, deniedText("Bash", DENY_NOTE));
  m = deny.message({ extra: 200, latencyMs: 1_900, completionExtra: 300 });
  m.say(
    [
      "Understood, no new dependency. I'll loop it in the shell instead: `for i in $(seq 50); do uv run pytest tests/test_csv_import.py -q -x || break; done`",
      "",
      "It stops at the first failure, so the output we need will be the last thing it prints. Say go and I'll run it.",
    ].join("\n"),
  );
  m.end();
  deny.finishTurn();
  out.add("deny.jsonl", deny);

  return {
    scenario: {
      id: ID,
      session: {
        title: "Flaky CSV import test",
        cwd: CWD,
        projectDir: CWD,
        mode: "default",
        model: "qwen3.8-27b-q8",
        effort: null,
      },
      storedEndedAgoMs: 3 * MINUTE,
      stored: "stored.jsonl",
      live: null,
      queuedBehind: null,
      branches: { [FLAKY_CSV_REQUEST]: { allow: "allow.jsonl", deny: "deny.jsonl" } },
      turns: [],
    },
    recordings: out.recordings,
    stats: out.stats,
  };
}
