/**
 * "Open file" on Settings → Subagents and Settings → Skills and commands: the person's own
 * editor opens an agent, skill or command file, with whatever app macOS opens Markdown with.
 *
 * Opening a file with the system can start a program (an `.app`, a `.command` script), so main
 * opens nothing a window names unless it is one of these files: a `.md` file, by its path under
 * an `agents`, `skills` or `commands` folder of a `.claude` or `.dawg` folder, which is a regular
 * file once links are followed. The folders are checked on the path as given (normalised), not on
 * the link's target, so a `~/.claude/agents` linked into a dotfiles repository still opens; the
 * target must still be a Markdown file. dawg never writes these files itself: the person edits
 * them in their editor, `.claude` ones included.
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

const CONFIG_ROOTS: ReadonlySet<string> = new Set([".claude", ".dawg"]);
const CONFIG_FOLDERS: ReadonlySet<string> = new Set(["agents", "skills", "commands"]);

function isMarkdown(file: string): boolean {
  return path.extname(file).toLowerCase() === ".md";
}

/** Whether a normalised absolute path is inside `<.claude or .dawg>/<agents, skills or commands>/`. */
export function isConfigFilePath(file: string): boolean {
  if (!path.isAbsolute(file) || !isMarkdown(file)) return false;
  const parts = path.normalize(file).split(path.sep);
  // The file itself is the last part; the folders come before it.
  for (let i = 0; i < parts.length - 2; i += 1) {
    if (CONFIG_ROOTS.has(parts[i] as string) && CONFIG_FOLDERS.has(parts[i + 1] as string)) {
      return true;
    }
  }
  return false;
}

/**
 * The file to open for a path a window sent, after checking it is an agent, skill or command
 * file that exists. Rejects with a sentence otherwise.
 */
export async function checkConfigFile(file: string): Promise<string> {
  const normalised = path.normalize(file);
  if (!isConfigFilePath(normalised)) {
    throw new Error("Only agent, skill and command files can be opened from here");
  }
  let real: string;
  try {
    real = await realpath(normalised);
  } catch {
    throw new Error(`${normalised} is not there any more`);
  }
  if (!isMarkdown(real) || !(await stat(real)).isFile()) {
    throw new Error(`${normalised} is not a Markdown file`);
  }
  return real;
}
