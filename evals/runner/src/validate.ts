import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopAdapter, referenceAdapter } from "./adapters/builtin.ts";
import type { ResultRow } from "./results.ts";
import { runSuite } from "./run.ts";
import { loadTasks } from "./task.ts";

export interface ValidateOptions {
  tasksDir: string;
  repoRoot: string;
  ids?: readonly string[];
  concurrency?: number;
  checkTimeoutMs?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface ValidateResult {
  ok: boolean;
  surprises: string[];
  taskCount: number;
  /** Artefacts are kept only when there was a surprise. */
  artifactsRoot: string | null;
}

/**
 * Checks every task's checker both ways: with `noop` the untouched fixture must FAIL, and with
 * `reference` the solution must PASS. Any other outcome, or a task that does not load, is a surprise.
 */
export async function validateTasks(opts: ValidateOptions): Promise<ValidateResult> {
  const log = opts.log ?? (() => {});
  const { tasks, errors } = loadTasks(opts.tasksDir, opts.ids);
  const surprises: string[] = errors.map((e) => `invalid: ${e.message}`);
  for (const s of surprises) log(`INVALID   ${s}`);

  const artifactsRoot = realpathSync(mkdtempSync(join(tmpdir(), "dawg-eval-validate-")));
  const common = {
    tasks,
    model: "none",
    trials: 1,
    concurrency: opts.concurrency,
    repoRoot: opts.repoRoot,
    resultsDir: null,
    artifactsRoot,
    ignoreRequires: true,
    checkTimeoutMs: opts.checkTimeoutMs,
    signal: opts.signal,
  };
  const noop = await runSuite({ ...common, adapter: noopAdapter() });
  const ref = await runSuite({ ...common, adapter: referenceAdapter() });

  const byTask = (rows: ResultRow[]) => new Map(rows.map((r) => [r.task, r]));
  const noopRows = byTask(noop.rows);
  const refRows = byTask(ref.rows);
  for (const task of tasks) {
    const n = noopRows.get(task.id);
    const r = refRows.get(task.id);
    const problems: string[] = [];
    if (n?.status !== "fail") {
      problems.push(
        `noop: expected fail, got ${n?.status ?? "nothing"}${n?.reason ? ` (${n.reason})` : ""}`,
      );
    }
    if (r?.status !== "pass") {
      problems.push(
        `reference: expected pass, got ${r?.status ?? "nothing"}${r?.reason ? ` (${r.reason})` : ""}`,
      );
    }
    if (problems.length === 0) {
      log(`ok        ${task.id}`);
    } else {
      const detail = `${task.id}: ${problems.join("; ")} [artefacts: ${n?.artifacts_dir ?? "-"}, ${r?.artifacts_dir ?? "-"}]`;
      surprises.push(detail);
      log(`SURPRISE  ${detail}`);
    }
  }

  const ok = surprises.length === 0;
  if (ok) rmSync(artifactsRoot, { recursive: true, force: true });
  return { ok, surprises, taskCount: tasks.length, artifactsRoot: ok ? null : artifactsRoot };
}
