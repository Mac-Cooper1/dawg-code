/**
 * A `ToolContext` for tests. Not exported from the package: import it by relative path.
 *
 *   const { ctx, progress, saved } = await createTestToolContext({ cwd: dir });
 *   const out = await readTool.execute({ file_path: "a.txt" }, ctx);
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PermissionMode, Question, QuestionAnswer, TaskItem } from "@dawg/protocol";
import {
  DEFAULT_TOOL_LIMITS,
  type SessionServices,
  type SessionStateBag,
  type ToolContext,
  type ToolLimits,
  type ToolProgress,
} from "../contracts/index.ts";

export interface TestToolContextOptions {
  /** Defaults to a fresh temporary directory. */
  cwd?: string;
  workingDirectories?: string[];
  limits?: Partial<ToolLimits>;
  env?: Record<string, string>;
  vision?: boolean;
  ripgrepPath?: string | null;
  signal?: AbortSignal;
  /** Share one bag between several contexts to model several calls in one session. */
  state?: SessionStateBag;
  session?: Partial<SessionServices>;
}

export interface TestToolContext {
  ctx: ToolContext;
  /** Every progress update the tool reported, in order. */
  progress: ToolProgress[];
  /** Every file written through `saveOutput`. */
  saved: { name: string; path: string }[];
  /** The task list as last set through `session.setTasks`. */
  tasks: TaskItem[];
  /** Call to interrupt the tool, when no `signal` option was given. */
  abort(): void;
  /** The folder `saveOutput` writes into. */
  outputDir: string;
  /** Removes the output folder, and the working directory if this helper created it. */
  cleanup(): Promise<void>;
}

export function createStateBag(): SessionStateBag {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string, create: () => T): T {
      if (!values.has(key)) values.set(key, create());
      return values.get(key) as T;
    },
  };
}

let callCounter = 0;

export async function createTestToolContext(
  options: TestToolContextOptions = {},
): Promise<TestToolContext> {
  const cwd = options.cwd ?? (await mkdtemp(path.join(tmpdir(), "dawg-tool-test-")));
  const outputDir = await mkdtemp(path.join(tmpdir(), "dawg-tool-results-"));
  const controller = new AbortController();
  const progress: ToolProgress[] = [];
  const saved: { name: string; path: string }[] = [];
  const tasks: TaskItem[] = [];
  let mode: PermissionMode = "default";

  const session: SessionServices = {
    getMode: () => mode,
    setMode: (next) => {
      mode = next;
    },
    setTasks: (next) => {
      tasks.splice(0, tasks.length, ...next);
    },
    askUser: async (questions: Question[]): Promise<QuestionAnswer[]> =>
      questions.map((q) => ({ question: q.question, selected: [], text: "" })),
    proposePlan: async () => ({ approved: true }),
    ...options.session,
  };

  callCounter += 1;
  const ctx: ToolContext = {
    sessionId: "test-session",
    toolCallId: `call-${callCounter}`,
    cwd,
    workingDirectories: options.workingDirectories ?? [cwd],
    state: options.state ?? createStateBag(),
    signal: options.signal ?? controller.signal,
    limits: { ...DEFAULT_TOOL_LIMITS, ...options.limits },
    env: options.env ?? {},
    vision: options.vision ?? false,
    ripgrepPath: options.ripgrepPath ?? null,
    session,
    progress: (update) => {
      progress.push(update);
    },
    saveOutput: async (name, content) => {
      const safe = name.replace(/[^A-Za-z0-9._-]/g, "_") || "output";
      const file = path.join(outputDir, `${saved.length + 1}-${safe}`);
      await writeFile(file, content);
      saved.push({ name, path: file });
      return file;
    },
  };

  const cleanup = async (): Promise<void> => {
    await rm(outputDir, { recursive: true, force: true });
    if (options.cwd === undefined) await rm(cwd, { recursive: true, force: true });
  };

  return { ctx, progress, saved, tasks, abort: () => controller.abort(), outputDir, cleanup };
}
