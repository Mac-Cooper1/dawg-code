# Eval tasks

Ten small, original projects, each with a prompt and a checker that decides
pass or fail with no human or model in the loop. The task contract (layout,
`task.yaml` fields, `TASK_DIR` / `WORKSPACE`, the git commit before the agent
runs) is in `docs/specs/phase-0-foundations.md` and the runner's own docs.

Every checker runs hidden assets from `check/` (never copied into the
workspace), so an agent cannot pass by editing visible tests. Each checker fails
on the untouched fixture and passes on `solution/`.

| Task | Language |
| --- | --- |
| fix-failing-test | Python |
| add-feature-two-files | JavaScript |
| rename-across-codebase | JavaScript |
| write-and-run-script | Python |
| answer-repo-question | Python |
| edit-with-awkward-whitespace | JavaScript |
| five-step-checklist | Python |
| recover-from-failing-command | JavaScript |
| change-deep-in-long-file | Python |
| long-context-many-files | JavaScript |

## The tasks

**fix-failing-test** (Python). A small invoicing library whose `percent_of`
uses Python's `round()` (banker's rounding) where the README requires
round-half-up, so one invoice test fails. The checker runs a hidden copy of the
tests plus extra rounding cases against the workspace code, runs the workspace
suite, and checks that no original test method was deleted. It rejects edited
expectations, a deleted test, and fixes made only in the invoice code.

**add-feature-two-files** (JavaScript). Add days (`d`, `day`/`days`) to a
duration library. The parser and the formatter each have their own unit
table, so the change touches two files. The checker runs hidden tests for parsing,
ordering rules, compact and long formatting, and round trips, plus the original
behaviour. It also requires the workspace suite to pass and at least one
workspace test to use a days duration, because the prompt asks for tests.

**rename-across-codebase** (JavaScript). Rename `normalizeSku` to
`canonicalSku` across 10 files: source, an aliased import, a re-export, the CLI,
tests, JSDoc and README. The checker requires that the old name appears in no
file, then runs hidden tests that import every module and the CLI with the new
name and that the old export is gone. It also runs the workspace suite.

**write-and-run-script** (Python). Write `summarize.py` to summarise a messy
expenses CSV: quoted fields with commas, inconsistent category spelling, and
invalid amounts. Then run it to produce `reports/summary.json`. The checker
compares that file to the expected JSON as values, so formatting does not
matter. It then runs the agent's script on a second, hidden CSV, which has a
tie for the largest expense, and compares that output too. A hand-written
output file or a script that hard-codes the answer fails. Expected values come
from the data generator, not from the reference script.

**answer-repo-question** (Python). Five questions about a webhook relay. To
answer them the agent must trace config defaults overridden by `relay.ini`,
work out a backoff schedule, and find the HMAC digest, the retryable 4xx codes
and the dead-letter file. Answers go in `ANSWER.md` in a stated format
(`## Qn` + `Answer:` line). The checker looks only at each `Answer:` line,
case-insensitively, after removing markdown. It requires the key token or number
and rejects the most likely wrong value, so explanations below the line are free.
It also fails if any tracked file was modified.

**edit-with-awkward-whitespace** (JavaScript). Three edits in a tab-indented
file with trailing spaces and tabs, including on the edited lines, and a
distractor (a second `1500`). The resulting file must be byte-identical to
`check/expected_settings.js`, and no other tracked file may change.

**five-step-checklist** (Python). Five deliverables in one request:
apostrophes inside words, `--min-length`, `--json`, a new `tests/test_cli.py`,
and a version bump with a CHANGELOG section. Each is checked separately and the
checker names the item that failed. The new test file must mention both
options, pass, and fail when run against the original package, so vacuous
tests do not count.

**recover-from-failing-command** (JavaScript). `bash ci.sh` fails twice in a
row. First the generator writes into a git-ignored directory that does not
exist in a fresh clone. After that, a test fails because of a data typo (foot =
0.3408 m). The checker copies the workspace and runs `git clean -X` to simulate
a fresh clone that keeps the agent's changes, then runs `ci.sh`. It compares
`build/units.json` to the expected output, runs a hidden copy of the tests, and
checks that `ci.sh` still runs its test step. Creating the directory by hand
does not pass.

**change-deep-in-long-file** (Python). A generated 3,134-line `cards.py`
(141 card classes). The bug is around line 2,580, in "Ember Tithe": it heals
by the last amount drained instead of the total, and crashes with no opponents.
The prompt describes the symptom only. The checker runs hidden Ember Tithe
tests. It plays every other card in a fixed scenario and compares the results
with fingerprints recorded from the original file. It also requires every
`git diff` hunk in `cards.py` to fall inside the Ember Tithe class, so
reformatting or rewriting the file fails.

**long-context-many-files** (JavaScript). An in-memory API with 30 route
files, 10 service modules and a permissions doc. Each route needs a scope that
depends on whether its code can write to the database, directly or through
services. Some routes are traps: a GET that writes through the audit service, a
GET that updates a session, and a read-only POST. The checker sends every route
requests with no auth, with insufficient scopes and with sufficient scopes. It
expects 401, then 403 with `required` naming the exact scope, then success, and
it checks that rejected requests change nothing. The workspace suite must also
pass.

## Validating the tasks

    bash evals/tasks/_tools/validate.sh            # all tasks
    bash evals/tasks/_tools/validate.sh -v ID...   # some tasks, with checker output on surprises

For each task the validator:

- checks `task.yaml`;
- checks that `check.sh` fails on the fixture and passes after `solution/` +
  `solution.sh`;
- runs every wrong-solution spot check in `_tools/wrong/<id>/*.sh` (each must
  fail);
- runs every alternative correct solution in `_tools/right/<id>/*.sh` (each
  must pass).

It needs bash, git, Node 24 and Python 3. It works offline and makes no
changes outside the system temp directory.

`bash evals/tasks/_tools/try.sh ID [SCRIPT|solution]` prepares one workspace,
optionally applies a script, runs the checker, shows its output, and leaves the
workspace in place for inspection.

## Generated files

Large or byte-sensitive fixtures are generated by scripts in `_tools/`, and
both the scripts and their output are committed. If you edit a generator, rerun
it and then the validator:

- `gen_write_and_run_script.py`: the expenses CSVs and expected summaries;
- `gen_edit_with_awkward_whitespace.py`: `settings.js` and its expected bytes;
- `gen_change_deep_in_long_file.py`: `cards.py`, the fixed copy, the target
  line span and the behaviour fingerprints;
- `gen_long_context_many_files.py`: the whole teamboard fixture and its
  reference solution. Afterwards, run
  `node evals/tasks/_tools/check_long_context_table.mjs`, which confirms that the
  hidden route table matches what each route actually does.
