/** "Export notes to Markdown": one finished turn, several days ago. */
import type { ScenarioDefinition } from "../define.ts";
import { DAY, Recordings, recorder, settings } from "../define.ts";
import { hunk } from "../text.ts";
import {
  callBash,
  callEdit,
  callReadRange,
  callWrite,
  runBash,
  runEdit,
  runReadRange,
  runWrite,
} from "../tools.ts";

const ID = "export-md";
const CWD = "~/code/notes-cli";

/** Lines 1-34 of src/notes_cli/cli.py (112 lines). */
const CLI_HEAD = [
  '"""The `notes` command."""',
  "",
  "from pathlib import Path",
  "",
  "import click",
  "from rich.console import Console",
  "",
  "from notes_cli.store import NoteStore, default_root",
  "",
  "console = Console()",
  "",
  "",
  "@click.group()",
  '@click.option("--root", type=click.Path(path_type=Path), default=default_root)',
  "@click.pass_context",
  "def main(ctx: click.Context, root: Path) -> None:",
  '    """Plain-text notes from the command line."""',
  "    ctx.obj = NoteStore(root)",
  "",
  "",
  "@main.command()",
  '@click.argument("title")',
  "@click.pass_obj",
  "def new(store: NoteStore, title: str) -> None:",
  '    """Start a note and open it in $EDITOR."""',
  "    note = store.create(title)",
  "    click.edit(filename=str(note.path))",
  "",
  "",
  '@main.command(name="list")',
  '@click.option("--tag", default=None, help="Only notes with this tag.")',
  "@click.pass_obj",
  "def list_notes(store: NoteStore, tag: str | None) -> None:",
  '    """List notes, newest first."""',
];

const EXPORT_PY = [
  '"""Write notes out as Markdown files, one per note."""',
  "",
  "from pathlib import Path",
  "",
  "import frontmatter",
  "",
  "from notes_cli.store import Note",
  "",
  "",
  "def slug(title: str) -> str:",
  '    keep = "".join(c.lower() if c.isalnum() else "-" for c in title)',
  '    return "-".join(part for part in keep.split("-") if part) or "untitled"',
  "",
  "",
  "def export_markdown(notes: list[Note], target: Path) -> list[Path]:",
  '    """Each note as <target>/<slug>.md, with its tags and dates as front matter."""',
  "    target.mkdir(parents=True, exist_ok=True)",
  "    written: list[Path] = []",
  "    for note in notes:",
  "        post = frontmatter.Post(note.body, title=note.title, tags=note.tags,",
  "                                created=note.created.isoformat())",
  '        path = target / f"{slug(note.title)}.md"',
  "        n = 2",
  "        while path in written:",
  '            path = target / f"{slug(note.title)}-{n}.md"',
  "            n += 1",
  '        path.write_text(frontmatter.dumps(post) + "\\n")',
  "        written.append(path)",
  "    return written",
  "",
].join("\n");

const CLI_IMPORT = hunk(8, 8, [
  " from notes_cli.store import NoteStore, default_root",
  "+from notes_cli.export import export_markdown",
  " ",
  " console = Console()",
]);

// Against the file after the import edit, so one line further down.
const CLI_COMMAND = hunk(19, 19, [
  "     ctx.obj = NoteStore(root)",
  " ",
  " ",
  '+@main.command(name="export")',
  '+@click.option("--format", "fmt", type=click.Choice(["md"]), default="md")',
  '+@click.argument("target", type=click.Path(path_type=Path))',
  "+@click.pass_obj",
  "+def export(store: NoteStore, fmt: str, target: Path) -> None:",
  '+    """Write every note to TARGET, one Markdown file each."""',
  "+    written = export_markdown(store.all(), target)",
  '+    console.print(f"Wrote {len(written)} notes to {target}")',
  "+",
  "+",
  " @main.command()",
  ' @click.argument("title")',
]);

export function exportMd(): ScenarioDefinition {
  const out = new Recordings();
  const rec = recorder({
    id: ID,
    cwd: CWD,
    seed: 97,
    settings: settings({ title: "Export notes to Markdown", mode: "acceptEdits" }),
  });

  rec.startTurn(
    "Add an `export --format md` command that writes each note to its own Markdown file.",
  );
  let m = rec.message({ latencyMs: 1_200, completionExtra: 500 });
  const read = callReadRange(m, rec, "src/notes_cli/cli.py", 1, 34);
  m.end();
  runReadRange(rec, read, CLI_HEAD, 112);
  m = rec.message({ extra: 1_200, latencyMs: 1_900, completionExtra: 900 });
  const write = callWrite(m, rec, "src/notes_cli/export.py", EXPORT_PY);
  m.end();
  runWrite(rec, write);
  m = rec.message({ extra: 400, latencyMs: 1_600, completionExtra: 500 });
  const importEdit = callEdit(m, rec, "src/notes_cli/cli.py", CLI_IMPORT);
  const commandEdit = callEdit(m, rec, "src/notes_cli/cli.py", CLI_COMMAND);
  m.end();
  runEdit(rec, importEdit, CLI_IMPORT);
  runEdit(rec, commandEdit, CLI_COMMAND);
  m = rec.message({ extra: 300, latencyMs: 1_200, completionExtra: 200 });
  const test = callBash(m, "uv run pytest -q", "Run the tests");
  m.end();
  runBash(rec, test, {
    output: "..............                                           [100%]\n14 passed in 0.42s\n",
    exitCode: 0,
    durationMs: 1_100,
  });
  m = rec.message({ extra: 200, latencyMs: 1_400, completionExtra: 300 });
  m.say(
    "Added `notes export --format md <folder>`: each note becomes `<folder>/<title>.md`, with its tags and creation date as front matter, and a number appended when two titles clash. The 14 tests pass; there is no test for the export yet, so say if you want one.",
  );
  m.end();
  rec.finishTurn();
  out.add("stored.jsonl", rec);

  return {
    scenario: {
      id: ID,
      session: {
        title: "Export notes to Markdown",
        cwd: CWD,
        projectDir: CWD,
        mode: "acceptEdits",
        model: "qwen3.8-27b-q8",
        effort: null,
      },
      storedEndedAgoMs: 5 * DAY + 2 * 60 * 60_000,
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
