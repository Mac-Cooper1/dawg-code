/**
 * `/memory`: where the session's memory and instruction files are, so the person can edit them
 * (Phase 4 spec, "Memory"). It makes the project's memory folder and an empty MEMORY.md when
 * there are none yet, so there is something to open. Clients open the files themselves: the app
 * shows the memory folder in the Files pane, and `dawg` opens MEMORY.md in `$EDITOR`.
 */
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadInstructions } from "@dawg/compat";
import { MEMORY_INDEX, MEMORY_MAX_LINES } from "../memory/index.ts";
import { type CommandContext, CommandError, type SlashCommand } from "./types.ts";

/** A path as a person reads it: relative inside the project, `~/` inside home, else absolute. */
export function displayPath(file: string, cwd: string, homeDir: string): string {
  const abs = path.resolve(file);
  const rel = path.relative(cwd, abs);
  if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  const fromHome = path.relative(homeDir, abs);
  if (fromHome !== "" && !fromHome.startsWith("..") && !path.isAbsolute(fromHome)) {
    return `~/${fromHome}`;
  }
  return abs;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** The instruction files that apply, and the usual ones not made yet. */
async function instructionFiles(ctx: CommandContext): Promise<{ path: string; note: string }[]> {
  const cwd = ctx.session.cwd;
  const set = await loadInstructions({ cwd, homeDir: ctx.homeDir, projectDir: cwd });
  const out = new Map<string, string>();
  const kinds: Record<string, string> = {
    user: "yours, for every project",
    project: "the project's",
    local: "yours, for this project",
    agents: "the project's",
    "user-rule": "your rule",
    "project-rule": "the project's rule",
  };
  for (const file of set.files) out.set(file.path, kinds[file.kind] ?? file.kind);
  const usual = [
    { path: path.join(cwd, "CLAUDE.md"), note: "the project's" },
    { path: path.join(cwd, "CLAUDE.local.md"), note: "yours, for this project" },
    { path: path.join(ctx.homeDir, ".claude", "CLAUDE.md"), note: "yours, for every project" },
  ];
  for (const file of usual) {
    if (!out.has(file.path) && !(await exists(file.path))) {
      out.set(file.path, `${file.note}; not made yet`);
    }
  }
  return [...out].map(([file, note]) => ({ path: file, note }));
}

export const memoryCommand: SlashCommand = {
  name: "memory",
  description: "Show the memory folder and instruction files, to edit them",
  argumentHint: null,
  async run(ctx) {
    if (ctx.args !== "") throw new CommandError(ctx.name, "/memory takes no arguments.");
    const s = ctx.session;
    const show = (file: string) => displayPath(file, s.cwd, ctx.homeDir);
    const lines: string[] = [];
    const memory = s.memory;
    if (memory === null) {
      lines.push("Auto memory is off for this session.");
    } else {
      await mkdir(memory.directory, { recursive: true });
      if (!(await exists(memory.indexPath))) await writeFile(memory.indexPath, "", { flag: "wx" });
      const topics = (await readdir(memory.directory).catch(() => [] as string[]))
        .filter((name) => name !== MEMORY_INDEX && !name.startsWith("."))
        .sort();
      lines.push(`Memory for this project: ${show(memory.directory)}`);
      lines.push(
        `  ${MEMORY_INDEX}: the index. Its first ${MEMORY_MAX_LINES} lines load when a session starts${memory.exists ? ` (this one loaded ${memory.loadedLines} of ${memory.totalLines})` : ""}.`,
      );
      for (const topic of topics) lines.push(`  ${topic}`);
    }
    lines.push("", "Instruction files:");
    for (const file of await instructionFiles(ctx)) {
      lines.push(`  ${show(file.path)} (${file.note})`);
    }
    lines.push(
      "",
      "Changes apply from the next session. Files under .claude/ are read, never written, by dawg: edit those in your own editor.",
    );
    return { kind: "output", text: lines.join("\n") };
  },
};
