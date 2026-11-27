/**
 * The person's on/off switch for single MCP servers (Settings → MCP servers, `/mcp off`), kept
 * in the engine's data root, never in a configuration file: Claude Code's files and the
 * project's stay as they are, and one person's choice is not committed for everyone.
 *
 *   <storeRoot>/mcp-switches.json
 *   { "version": 1, "user": ["github"], "projects": { "/abs/project": ["db"] } }
 *
 * A server of the person's own for every project is turned off everywhere; any other (the
 * project's, or theirs for this project) for that project only.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const SWITCHES_FILE = "mcp-switches.json";

interface SwitchesFile {
  version: 1;
  user: string[];
  projects: Record<string, string[]>;
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export class McpSwitches {
  readonly file: string;
  /** Read-modify-write steps run one after another. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(storeRoot: string) {
    this.file = path.join(path.resolve(storeRoot), SWITCHES_FILE);
  }

  /** The names turned off for a session in `projectDir`, by scope. */
  async off(projectDir: string | null): Promise<{ user: Set<string>; project: Set<string> }> {
    const data = await this.#read();
    const project = projectDir === null ? [] : (data.projects[path.resolve(projectDir)] ?? []);
    return { user: new Set(data.user), project: new Set(project) };
  }

  set(input: {
    projectDir: string | null;
    name: string;
    scope: "user" | "project";
    enabled: boolean;
  }): Promise<void> {
    const step = this.#queue.then(async () => {
      const data = await this.#read();
      const key = input.projectDir === null ? null : path.resolve(input.projectDir);
      const list = input.scope === "user" || key === null ? data.user : (data.projects[key] ?? []);
      const off = new Set(list);
      if (input.enabled) off.delete(input.name);
      else off.add(input.name);
      const sorted = [...off].sort();
      if (input.scope === "user" || key === null) data.user = sorted;
      else if (sorted.length === 0) delete data.projects[key];
      else data.projects[key] = sorted;
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(temp, this.file);
    });
    this.#queue = step.catch(() => {});
    return step;
  }

  async #read(): Promise<SwitchesFile> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Record<string, unknown>;
      const projects: Record<string, string[]> = {};
      if (raw.projects !== null && typeof raw.projects === "object") {
        for (const [dir, list] of Object.entries(raw.projects as Record<string, unknown>)) {
          projects[dir] = names(list);
        }
      }
      return { version: 1, user: names(raw.user), projects };
    } catch {
      // Missing or damaged: every server is on.
      return { version: 1, user: [], projects: {} };
    }
  }
}
