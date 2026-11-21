import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { slugify } from "./adapters/launch.ts";
import {
  type AgentAdapter,
  type AgentRunResult,
  DUMMY_API_KEY,
  type Endpoint,
  unmetRequirements,
} from "./adapters/types.ts";
import { computeMetrics, emptyMetrics, readRecordFile } from "./metrics.ts";
import { type RunningProxy, startProxy } from "./proxy.ts";
import {
  appendResult,
  RESULT_SCHEMA_VERSION,
  type ResultRow,
  resultFileName,
  sanitizeEndpoint,
} from "./results.ts";
import type { Task } from "./task.ts";
import {
  finalDiff,
  prepareWorkspace,
  removeWorkspace,
  runScript,
  scriptEnv,
  type Workspace,
} from "./workspace.ts";

export const CHECK_TIMEOUT_MS = 60_000;

export interface EndpointOptions {
  /** Upstream base URL ending in /v1. */
  url: string;
  /** Env var holding the real key; passed by name to the proxy, never read here. */
  keyEnv?: string;
  /** argv words that launch the proxy. */
  proxyCommand: string[];
}

export interface RunOptions {
  adapter: AgentAdapter;
  tasks: readonly Task[];
  model: string;
  /** Overrides each task's `trials`. */
  trials?: number;
  concurrency?: number;
  /** Keep the workspace of runs that did not pass. */
  keep?: boolean;
  repoRoot: string;
  /** Where result rows are appended; null writes no rows (used by `validate`). */
  resultsDir: string | null;
  /** Parent of the per-run artefact directories. */
  artifactsRoot: string;
  /** Required when the adapter needs a model endpoint. */
  endpoint?: EndpointOptions;
  label?: string;
  checkTimeoutMs?: number;
  /** Overrides each task's timeout (tests). */
  agentTimeoutMs?: number;
  /** Treat every task as runnable, whatever it requires (used by `validate`). */
  ignoreRequires?: boolean;
  signal?: AbortSignal;
  onRow?: (row: ResultRow) => void;
  now?: () => Date;
  /** Parent of temp workspaces; defaults to os.tmpdir(). */
  tempParent?: string;
}

export interface RunSummary {
  rows: ResultRow[];
  resultsFile: string | null;
}

function compactStamp(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

function displayPath(repoRoot: string, p: string): string {
  const rel = relative(repoRoot, p);
  return rel.startsWith("..") || rel.startsWith("/") ? p : rel;
}

type RowBase = Pick<
  ResultRow,
  "schema" | "run_id" | "started_at" | "agent" | "model" | "endpoint" | "label" | "task" | "trial"
>;

interface Job {
  task: Task;
  trial: number;
}

export async function runSuite(opts: RunOptions): Promise<RunSummary> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  if (opts.adapter.needsEndpoint && !opts.endpoint) {
    throw new Error(
      `agent "${opts.adapter.id}" needs an endpoint (--endpoint or DAWG_DEV_ENDPOINT_URL)`,
    );
  }
  const fileName = resultFileName(startedAt, opts.adapter.id, opts.model);
  let resultsFile: string | null = null;
  const rows: ResultRow[] = [];

  const emit = (row: ResultRow) => {
    rows.push(row);
    if (opts.resultsDir) resultsFile = appendResult(opts.resultsDir, fileName, row);
    opts.onRow?.(row);
  };

  const base = (task: Task, trial: number, runId: string): RowBase => ({
    schema: RESULT_SCHEMA_VERSION,
    run_id: runId,
    started_at: now().toISOString(),
    agent: opts.adapter.id,
    model: opts.model,
    endpoint:
      opts.adapter.needsEndpoint && opts.endpoint ? sanitizeEndpoint(opts.endpoint.url) : null,
    label: opts.label ?? null,
    task: task.id,
    trial,
  });

  const jobs: Job[] = [];
  for (const task of opts.tasks) {
    const unmet = opts.ignoreRequires ? [] : unmetRequirements(opts.adapter, task);
    if (unmet.length > 0) {
      emit({
        ...base(task, 0, `${compactStamp(startedAt)}-${slugify(opts.adapter.id)}-${task.id}-skip`),
        status: "skipped",
        reason: `agent lacks: ${unmet.join(", ")}`,
        check_exit_code: null,
        check_timed_out: false,
        agent_exit_code: null,
        agent_timed_out: false,
        wall_ms: null,
        metrics: emptyMetrics(),
        artifacts_dir: null,
        workspace: null,
      });
      continue;
    }
    const n = opts.trials ?? task.trials;
    for (let t = 1; t <= n; t++) jobs.push({ task, trial: t });
  }

  const concurrency = Math.max(1, opts.concurrency ?? 1);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      if (opts.signal?.aborted) return;
      const job = jobs[next++] as Job;
      emit(await runOne(opts, job, base));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return { rows, resultsFile };
}

async function runOne(
  opts: RunOptions,
  { task, trial }: Job,
  base: (task: Task, trial: number, runId: string) => RowBase,
): Promise<ResultRow> {
  const now = opts.now ?? (() => new Date());
  const runId = `${compactStamp(now())}-${slugify(opts.adapter.id)}-${task.id}-t${trial}-${randomBytes(3).toString("hex")}`;
  const artifactsDir = join(opts.artifactsRoot, runId);
  mkdirSync(artifactsDir, { recursive: true });
  const signal = opts.signal ?? new AbortController().signal;

  const row: ResultRow = {
    ...base(task, trial, runId),
    status: "error",
    reason: null,
    check_exit_code: null,
    check_timed_out: false,
    agent_exit_code: null,
    agent_timed_out: false,
    wall_ms: null,
    metrics: emptyMetrics(),
    artifacts_dir: displayPath(opts.repoRoot, artifactsDir),
    workspace: null,
  };

  let ws: Workspace | null = null;
  let proxy: RunningProxy | null = null;
  const recordPath = join(artifactsDir, "proxy.jsonl");
  try {
    ws = await prepareWorkspace(task, { artifactsDir, signal, tempParent: opts.tempParent });

    let endpoint: Endpoint | null = null;
    if (opts.adapter.needsEndpoint && opts.endpoint) {
      proxy = await startProxy({
        command: opts.endpoint.proxyCommand,
        upstream: opts.endpoint.url,
        upstreamKeyEnv: opts.endpoint.keyEnv,
        recordPath,
        stderrPath: join(artifactsDir, "proxy.stderr.log"),
        label: runId,
      });
      endpoint = {
        openaiBaseUrl: `http://127.0.0.1:${proxy.port}/v1`,
        anthropicBaseUrl: `http://127.0.0.1:${proxy.port}`,
        apiKey: DUMMY_API_KEY,
        model: opts.model,
      };
    }

    const started = performance.now();
    let agent: AgentRunResult;
    try {
      agent = await opts.adapter.run({
        task,
        workspace: ws.dir,
        prompt: task.prompt,
        homeDir: ws.homeDir,
        tmpDir: ws.tmpDir,
        artifactsDir,
        taskDir: task.dir,
        endpoint,
        timeoutMs: opts.agentTimeoutMs ?? task.timeoutSeconds * 1000,
        signal,
      });
    } finally {
      row.wall_ms = Math.round(performance.now() - started);
      if (proxy) await proxy.stop();
    }
    row.agent_exit_code = agent.exitCode;
    row.agent_timed_out = agent.timedOut;
    if (proxy) row.metrics = computeMetrics(readRecordFile(recordPath));

    if (agent.error) {
      row.reason = `agent could not start: ${agent.error}`;
      return row;
    }
    if (signal.aborted) {
      row.reason = "aborted";
      return row;
    }

    // The diff is taken before check.sh, so files the checker creates do not pollute it.
    try {
      writeFileSync(join(artifactsDir, "diff.patch"), await finalDiff(ws));
    } catch (err) {
      writeFileSync(join(artifactsDir, "diff.error.txt"), String(err));
    }

    const check = await runScript({
      script: task.checkScript,
      cwd: ws.dir,
      env: scriptEnv(task, ws),
      stdoutPath: join(artifactsDir, "check.stdout.log"),
      stderrPath: join(artifactsDir, "check.stderr.log"),
      timeoutMs: opts.checkTimeoutMs ?? CHECK_TIMEOUT_MS,
      signal,
    });
    row.check_exit_code = check.exitCode;
    row.check_timed_out = check.timedOut;
    if (check.spawnError) {
      row.reason = `check.sh could not start: ${check.spawnError}`;
      return row;
    }
    if (check.aborted) {
      row.reason = "aborted";
      return row;
    }
    const passed = check.exitCode === 0 && !check.timedOut;
    row.status = passed ? "pass" : "fail";
    if (!passed) {
      row.reason = check.timedOut
        ? "check.sh timed out"
        : agent.timedOut
          ? "agent timed out; check.sh failed"
          : `check.sh exited ${check.exitCode ?? check.signal}`;
    }
    return row;
  } catch (err) {
    row.reason = (err as Error).message;
    if (proxy) await proxy.stop();
    return row;
  } finally {
    if (ws) {
      if (opts.keep && row.status !== "pass") row.workspace = ws.root;
      else removeWorkspace(ws);
    }
  }
}
