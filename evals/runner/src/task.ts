import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const DEFAULT_TIMEOUT_SECONDS = 900;
export const DEFAULT_TRIALS = 3;

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const taskYamlSchema = z.strictObject({
  id: z.string().regex(KEBAB, "must be kebab-case (a-z, 0-9, single hyphens)"),
  title: z.string().trim().min(1, "must be a non-empty string"),
  prompt: z.string().trim().min(1, "must be a non-empty string"),
  tags: z.array(z.string().min(1)).default([]),
  timeout_seconds: z.number().int().positive().default(DEFAULT_TIMEOUT_SECONDS),
  trials: z.number().int().positive().default(DEFAULT_TRIALS),
  requires: z.array(z.string().min(1)).default([]),
});

export interface Task {
  id: string;
  title: string;
  /** The exact prompt text from task.yaml. */
  prompt: string;
  tags: string[];
  timeoutSeconds: number;
  trials: number;
  requires: string[];
  /** Absolute path of the task directory. */
  dir: string;
  fixtureDir: string;
  solutionDir: string;
  setupScript: string | null;
  checkScript: string;
  solutionScript: string | null;
}

export class TaskError extends Error {
  readonly taskId: string;
  readonly field: string | null;
  constructor(taskId: string, field: string | null, message: string) {
    super(`task "${taskId}"${field ? `, field "${field}"` : ""}: ${message}`);
    this.name = "TaskError";
    this.taskId = taskId;
    this.field = field;
  }
}

function isDir(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}
function isFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile();
}

/** Loads and validates one task directory. Throws a TaskError naming the task and field. */
export function loadTask(dirPath: string): Task {
  const dir = resolve(dirPath);
  const name = dir.split("/").pop() ?? dir;
  const yamlPath = join(dir, "task.yaml");
  if (!isFile(yamlPath)) throw new TaskError(name, null, "missing task.yaml");

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(yamlPath, "utf8"));
  } catch (err) {
    throw new TaskError(name, null, `task.yaml is not valid YAML: ${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TaskError(name, null, "task.yaml must be a mapping");
  }

  const parsed = taskYamlSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.length ? issue.path.map(String).join(".") : null;
    let message = issue?.message ?? "invalid";
    if (issue?.code === "unrecognized_keys") message = `unknown field(s): ${issue.keys.join(", ")}`;
    throw new TaskError(name, field, message);
  }
  const t = parsed.data;
  if (t.id !== name) {
    throw new TaskError(name, "id", `must equal the directory name "${name}" (got "${t.id}")`);
  }

  const fixtureDir = join(dir, "fixture");
  if (!isDir(fixtureDir)) throw new TaskError(name, "fixture/", "missing fixture/ directory");
  const checkScript = join(dir, "check.sh");
  if (!isFile(checkScript)) throw new TaskError(name, "check.sh", "missing check.sh");
  const solutionDir = join(dir, "solution");
  if (!isDir(solutionDir)) throw new TaskError(name, "solution/", "missing solution/ directory");
  const setupScript = join(dir, "setup.sh");
  const solutionScript = join(dir, "solution.sh");

  return {
    id: t.id,
    title: t.title,
    prompt: t.prompt,
    tags: t.tags,
    timeoutSeconds: t.timeout_seconds,
    trials: t.trials,
    requires: t.requires,
    dir,
    fixtureDir,
    solutionDir,
    setupScript: isFile(setupScript) ? setupScript : null,
    checkScript,
    solutionScript: isFile(solutionScript) ? solutionScript : null,
  };
}

/** Task directory names under the tasks root, skipping names starting with `_` or `.`. */
export function listTaskDirs(tasksRoot: string): string[] {
  if (!isDir(tasksRoot)) return [];
  return readdirSync(tasksRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

export interface LoadedTasks {
  tasks: Task[];
  errors: TaskError[];
}

/**
 * Loads every task under the root (or only `ids`, in the order given). Invalid tasks are returned
 * as errors rather than thrown, so one bad task does not hide the rest.
 */
export function loadTasks(tasksRoot: string, ids?: readonly string[]): LoadedTasks {
  const root = resolve(tasksRoot);
  const names = ids && ids.length > 0 ? [...ids] : listTaskDirs(root);
  const tasks: Task[] = [];
  const errors: TaskError[] = [];
  for (const name of names) {
    const dir = join(root, name);
    if (!isDir(dir)) {
      errors.push(new TaskError(name, null, `no task directory at ${dir}`));
      continue;
    }
    try {
      tasks.push(loadTask(dir));
    } catch (err) {
      errors.push(err instanceof TaskError ? err : new TaskError(name, null, String(err)));
    }
  }
  return { tasks, errors };
}
