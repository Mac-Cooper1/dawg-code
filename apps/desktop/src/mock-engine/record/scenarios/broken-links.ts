/** "Fix broken links in docs": one finished turn, yesterday. */
import type { ScenarioDefinition } from "../define.ts";
import { HOUR, Recordings, recorder, settings } from "../define.ts";
import { hunk } from "../text.ts";
import { callEdit, callGrep, runEdit, runGrep } from "../tools.ts";

const ID = "broken-links";
const CWD = "~/code/dawg-site";

const GETTING_STARTED = hunk(11, 11, [
  " ",
  " dawg runs a model on your Mac. The first start downloads one; it takes a few minutes on a",
  " fast connection.",
  "-See [the models guide](/docs/models) to pick another.",
  "+See [the models guide](/guide/models) to pick another.",
  " ",
  " ## Your first session",
  " ",
]);

const SESSIONS = hunk(28, 28, [
  " ",
  " A session can run in its own git worktree, so two sessions never edit the same files.",
  " ",
  "-Read [worktrees](/docs/worktrees) before you start one on a repository with submodules.",
  "+Read [worktrees](/guide/worktrees) before you start one on a repository with submodules.",
  " ",
  " ## Forking",
  " ",
]);

export function brokenLinks(): ScenarioDefinition {
  const out = new Recordings();
  const rec = recorder({
    id: ID,
    cwd: CWD,
    seed: 71,
    settings: settings({ title: "Fix broken links in docs", mode: "acceptEdits" }),
  });

  rec.startTurn(
    "Some links in the docs 404 since the guide moved under /guide. Find and fix them.",
  );
  let m = rec.message({ latencyMs: 1_300, completionExtra: 400 });
  const grep = callGrep(m, "\\]\\(/docs/", { glob: "*.md", output_mode: "content" });
  m.end();
  runGrep(rec, grep, [
    {
      file: "src/content/docs/getting-started.md",
      line: 14,
      text: "See [the models guide](/docs/models) to pick another.",
    },
    {
      file: "src/content/docs/sessions.md",
      line: 31,
      text: "Read [worktrees](/docs/worktrees) before you start one on a repository with submodules.",
    },
  ]);
  m = rec.message({ extra: 300, latencyMs: 1_500, completionExtra: 300 });
  const first = callEdit(m, rec, "src/content/docs/getting-started.md", GETTING_STARTED);
  m.end();
  runEdit(rec, first, GETTING_STARTED);
  m = rec.message({ extra: 200, latencyMs: 1_200, completionExtra: 200 });
  const second = callEdit(m, rec, "src/content/docs/sessions.md", SESSIONS);
  m.end();
  runEdit(rec, second, SESSIONS);
  m = rec.message({ extra: 200, latencyMs: 1_400, completionExtra: 200 });
  m.say(
    [
      "Fixed the two links that still pointed at `/docs/`:",
      "",
      "- `getting-started.md`: the models guide is now `/guide/models`",
      "- `sessions.md`: worktrees is now `/guide/worktrees`",
      "",
      "No other page links to the old path, and the redirect in `astro.config.mjs` still catches old bookmarks.",
    ].join("\n"),
  );
  m.end();
  rec.finishTurn();
  out.add("stored.jsonl", rec);

  return {
    scenario: {
      id: ID,
      session: {
        title: "Fix broken links in docs",
        cwd: CWD,
        projectDir: CWD,
        mode: "acceptEdits",
        model: "qwen3.8-27b-q8",
        effort: null,
      },
      storedEndedAgoMs: 26 * HOUR,
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
