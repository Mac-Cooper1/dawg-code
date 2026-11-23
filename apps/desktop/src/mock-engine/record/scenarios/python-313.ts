/**
 * "Bump to Python 3.13": the model stops responding part-way through a reply, so the turn ends
 * with an error and the session's status is "error".
 */
import type { ScenarioDefinition } from "../define.ts";
import { DAY, HOUR, Recordings, recorder, settings } from "../define.ts";
import { hunk } from "../text.ts";
import { callBash, callEdit, callRead, runBash, runEdit, runRead } from "../tools.ts";

const ID = "python-313";
const CWD = "~/code/notes-cli";

const PYPROJECT = [
  "[project]",
  'name = "notes-cli"',
  'version = "0.6.2"',
  'description = "Plain-text notes from the command line."',
  'readme = "README.md"',
  'requires-python = ">=3.11"',
  'license = "MIT"',
  "dependencies = [",
  '    "click>=8.1",',
  '    "python-frontmatter>=1.1",',
  '    "rich>=13.7",',
  "]",
  "",
  "[project.scripts]",
  'notes = "notes_cli.cli:main"',
  "",
  "[dependency-groups]",
  'dev = ["pytest>=8.3", "ruff>=0.7"]',
  "",
  "[build-system]",
  'requires = ["hatchling"]',
  'build-backend = "hatchling.build"',
  "",
  "[tool.ruff]",
  'target-version = "py311"',
  "line-length = 100",
];

const REQUIRES = hunk(3, 3, [
  ' version = "0.6.2"',
  ' description = "Plain-text notes from the command line."',
  ' readme = "README.md"',
  '-requires-python = ">=3.11"',
  '+requires-python = ">=3.13"',
  ' license = "MIT"',
  " dependencies = [",
  '     "click>=8.1",',
]);

const RUFF = hunk(23, 23, [
  " ",
  " [tool.ruff]",
  '-target-version = "py311"',
  '+target-version = "py313"',
  " line-length = 100",
]);

const UV_SYNC = [
  "Using CPython 3.13.1",
  "Removed virtual environment at: .venv",
  "Creating virtual environment at: .venv",
  "Resolved 19 packages in 2ms",
  "Prepared 3 packages in 812ms",
  "Installed 16 packages in 38ms",
  " + click==8.1.8",
  " + iniconfig==2.0.0",
  " + markdown-it-py==3.0.0",
  " + mdurl==0.1.2",
  " + notes-cli==0.6.2 (from file://~/code/notes-cli)",
  " + packaging==24.2",
  " + pluggy==1.5.0",
  " + pygments==2.18.0",
  " + pytest==8.3.4",
  " + python-frontmatter==1.1.0",
  " + pyyaml==6.0.2",
  " + rich==13.9.4",
  " + ruff==0.8.4",
  "",
].join("\n");

export function python313(): ScenarioDefinition {
  const out = new Recordings();
  const rec = recorder({
    id: ID,
    cwd: CWD,
    seed: 83,
    settings: settings({ title: "Bump to Python 3.13", mode: "acceptEdits" }),
  });

  rec.startTurn("Bump the project to Python 3.13 and fix whatever breaks.");
  let m = rec.message({ latencyMs: 1_200, completionExtra: 400 });
  const read = callRead(m, rec, "pyproject.toml");
  m.end();
  runRead(rec, read, PYPROJECT);
  m = rec.message({ extra: 500, latencyMs: 1_600, completionExtra: 300 });
  const requires = callEdit(m, rec, "pyproject.toml", REQUIRES);
  const ruff = callEdit(m, rec, "pyproject.toml", RUFF);
  m.end();
  runEdit(rec, requires, REQUIRES);
  runEdit(rec, ruff, RUFF);
  m = rec.message({ extra: 300, latencyMs: 1_300, completionExtra: 200 });
  const sync = callBash(m, "uv sync", "Recreate the environment on Python 3.13");
  m.end();
  runBash(rec, sync, { output: UV_SYNC, exitCode: 0, durationMs: 2_300 });

  // The next request starts thinking, then the endpoint goes quiet until the request times out.
  m = rec.message({ extra: 700, latencyMs: 1_500 });
  m.think(
    "3.13 removed the old stdlib modules from PEP 594 (cgi, imghdr, pipes, telnetlib and others). Search the package for imports of them before running the tests, since",
  );
  rec.wait(120_000);
  m.abort();
  rec.finishTurn({
    stopReason: "error",
    error: {
      kind: "model_unavailable",
      message: "The model stopped responding.",
      detail:
        "No data from http://127.0.0.1:8384/v1/chat/completions for 120 s, so the request was stopped (read timeout).",
      retryable: true,
    },
  });
  out.add("stored.jsonl", rec);

  return {
    scenario: {
      id: ID,
      session: {
        title: "Bump to Python 3.13",
        cwd: CWD,
        projectDir: CWD,
        mode: "acceptEdits",
        model: "qwen3.8-27b-q8",
        effort: null,
      },
      storedEndedAgoMs: 5 * DAY - 3 * HOUR,
      stored: "stored.jsonl",
      live: null,
      queuedBehind: null,
      branches: {},
      turns: [],
    },
    recordings: out.recordings,
    stats: out.stats,
  };
}
