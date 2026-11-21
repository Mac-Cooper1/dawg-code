#!/usr/bin/env node
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ADAPTER_IDS, createAdapter } from "./adapters/index.ts";
import { defaultProxyCommand, parseProxyCommand } from "./proxy.ts";
import { renderReport } from "./report.ts";
import { type ResultRow, readResultFiles } from "./results.ts";
import { runSuite } from "./run.ts";
import { loadTasks } from "./task.ts";
import { validateTasks } from "./validate.ts";

/** evals/runner/src/cli.ts (or dist/cli.js) → repo root. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const USAGE = `dawg eval runner

Usage:
  node evals/runner/src/cli.ts run --agent <id> [--model <name>] [options]
  node evals/runner/src/cli.ts report <results.jsonl...> [--out <file.md>]
  node evals/runner/src/cli.ts validate [--tasks a,b] [--concurrency n]
  node evals/runner/src/cli.ts list

run options:
  --agent <id>             ${ADAPTER_IDS.join(" | ")}
  --model <name>           model name sent to the endpoint (default: $DAWG_DEV_MODEL)
  --endpoint <url>         upstream base URL ending in /v1 (default: $DAWG_DEV_ENDPOINT_URL)
  --endpoint-key-env <ENV> env var holding the upstream key (default: DAWG_DEV_API_KEY)
  --tasks a,b              only these task ids
  --trials <n>             override each task's trial count
  --concurrency <n>        parallel runs (default 1)
  --keep                   keep the workspace of runs that did not pass
  --label <text>           note stored in each row, e.g. provider and precision
  --agent-cmd <template>   command template for --agent command
  --agent-bin <path>       executable for opencode / pi / claude-code / dawg
  --agent-features a,b     extra features the agent claims (matched against task 'requires')
  --proxy-cmd <command>    how to launch the recording proxy (default: node evals/proxy/src/cli.ts)

common options:
  --tasks-dir <dir>        default: evals/tasks
  --results-dir <dir>      default: evals/results (artefacts go to <results-dir>/tmp/<run-id>/)
`;

const OPTIONS = {
  agent: { type: "string" },
  model: { type: "string" },
  endpoint: { type: "string" },
  "endpoint-key-env": { type: "string" },
  tasks: { type: "string" },
  trials: { type: "string" },
  concurrency: { type: "string" },
  keep: { type: "boolean" },
  label: { type: "string" },
  "agent-cmd": { type: "string" },
  "agent-bin": { type: "string" },
  "agent-features": { type: "string" },
  "proxy-cmd": { type: "string" },
  "tasks-dir": { type: "string" },
  "results-dir": { type: "string" },
  out: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

class UsageError extends Error {}

function list(s: string | undefined): string[] | undefined {
  if (s === undefined) return undefined;
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function positiveInt(name: string, s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive integer`);
  return n;
}

function loadDotEnv(): void {
  const p = join(REPO_ROOT, ".env");
  if (existsSync(p)) process.loadEnvFile(p);
}

function formatRow(r: ResultRow): string {
  const status = r.status.toUpperCase().padEnd(7);
  const wall = r.wall_ms === null ? "" : ` ${(r.wall_ms / 1000).toFixed(1)}s`;
  const reqs = r.metrics.requests > 0 ? ` ${r.metrics.requests} req` : "";
  const reason = r.reason ? `  (${r.reason})` : "";
  return `${status} ${r.task}${r.trial > 0 ? ` #${r.trial}` : ""}${wall}${reqs}${reason}`;
}

async function cmdRun(v: Record<string, string | boolean | undefined>): Promise<number> {
  loadDotEnv();
  const agentId = v.agent as string | undefined;
  if (!agentId) throw new UsageError("run needs --agent");
  const adapter = createAdapter(agentId, {
    agentCmd: v["agent-cmd"] as string | undefined,
    agentBin: v["agent-bin"] as string | undefined,
    features: list(v["agent-features"] as string | undefined),
  });

  const tasksDir = resolve(
    (v["tasks-dir"] as string | undefined) ?? join(REPO_ROOT, "evals", "tasks"),
  );
  const resultsDir = resolve(
    (v["results-dir"] as string | undefined) ?? join(REPO_ROOT, "evals", "results"),
  );
  const { tasks, errors } = loadTasks(tasksDir, list(v.tasks as string | undefined));
  for (const e of errors) console.error(`invalid task: ${e.message}`);
  if (tasks.length === 0) {
    console.error(`no runnable tasks in ${tasksDir}`);
    return 1;
  }

  let model = (v.model as string | undefined) ?? process.env.DAWG_DEV_MODEL;
  let endpoint: Parameters<typeof runSuite>[0]["endpoint"];
  if (adapter.needsEndpoint) {
    if (!model) throw new UsageError("--model is required (or set DAWG_DEV_MODEL)");
    const url = ((v.endpoint as string | undefined) ?? process.env.DAWG_DEV_ENDPOINT_URL)?.replace(
      /\/+$/,
      "",
    );
    if (!url) throw new UsageError("--endpoint is required (or set DAWG_DEV_ENDPOINT_URL)");
    if (!/^https?:\/\/.+\/v1$/.test(url)) {
      throw new UsageError(`--endpoint must be an http(s) URL ending in /v1 (got ${url})`);
    }
    const explicitKeyEnv = v["endpoint-key-env"] as string | undefined;
    const keyEnv = explicitKeyEnv ?? "DAWG_DEV_API_KEY";
    let passKeyEnv: string | undefined = keyEnv;
    if (!process.env[keyEnv]) {
      if (explicitKeyEnv) throw new UsageError(`environment variable ${keyEnv} is not set`);
      console.error(`note: ${keyEnv} is not set; the proxy will forward requests without a key`);
      passKeyEnv = undefined;
    }
    const proxyCmd = v["proxy-cmd"] as string | undefined;
    endpoint = {
      url,
      keyEnv: passKeyEnv,
      proxyCommand: proxyCmd ? parseProxyCommand(proxyCmd) : defaultProxyCommand(REPO_ROOT),
    };
  }
  model ??= "none";

  const ac = new AbortController();
  let interrupts = 0;
  process.on("SIGINT", () => {
    if (++interrupts > 1) process.exit(130);
    console.error("interrupt: stopping running agents (press Ctrl-C again to force)");
    ac.abort();
  });

  const summary = await runSuite({
    adapter,
    tasks,
    model,
    trials: positiveInt("trials", v.trials as string | undefined),
    concurrency: positiveInt("concurrency", v.concurrency as string | undefined),
    keep: v.keep === true,
    repoRoot: REPO_ROOT,
    resultsDir,
    artifactsRoot: join(resultsDir, "tmp"),
    endpoint,
    label: v.label as string | undefined,
    signal: ac.signal,
    onRow: (r) => {
      console.log(formatRow(r));
      if (r.workspace) console.log(`        workspace kept: ${r.workspace}`);
    },
  });

  const ran = summary.rows.filter((r) => r.status !== "skipped");
  const passed = ran.filter((r) => r.status === "pass").length;
  const errored = ran.filter((r) => r.status === "error").length;
  console.log(`\n${passed}/${ran.length} passed${errored ? `, ${errored} errors` : ""}`);
  if (summary.resultsFile) console.log(`results: ${summary.resultsFile}`);
  return errors.length > 0 || errored > 0 || ac.signal.aborted ? 1 : 0;
}

function cmdReport(files: string[], v: Record<string, string | boolean | undefined>): number {
  if (files.length === 0) throw new UsageError("report needs one or more result files");
  const { rows, errors } = readResultFiles(files);
  for (const e of errors) console.error(`skipped row: ${e}`);
  const md = renderReport({ rows, sources: files });
  const out = v.out as string | undefined;
  if (out) {
    writeFileSync(out, md);
    console.error(`wrote ${out}`);
  } else {
    process.stdout.write(md);
  }
  return errors.length > 0 ? 1 : 0;
}

async function cmdValidate(v: Record<string, string | boolean | undefined>): Promise<number> {
  const tasksDir = resolve(
    (v["tasks-dir"] as string | undefined) ?? join(REPO_ROOT, "evals", "tasks"),
  );
  const res = await validateTasks({
    tasksDir,
    repoRoot: REPO_ROOT,
    ids: list(v.tasks as string | undefined),
    concurrency: positiveInt("concurrency", v.concurrency as string | undefined),
    log: (l) => console.log(l),
  });
  if (res.taskCount === 0 && res.surprises.length === 0) {
    console.error(`no tasks found in ${tasksDir}`);
    return 1;
  }
  if (res.ok) {
    console.log(`\nall ${res.taskCount} tasks behave: noop fails, reference passes`);
    return 0;
  }
  console.log(`\n${res.surprises.length} surprise(s); artefacts kept in ${res.artifactsRoot}`);
  return 1;
}

function cmdList(v: Record<string, string | boolean | undefined>): number {
  const tasksDir = resolve(
    (v["tasks-dir"] as string | undefined) ?? join(REPO_ROOT, "evals", "tasks"),
  );
  const { tasks, errors } = loadTasks(tasksDir);
  for (const t of tasks) {
    const req = t.requires.length ? `  requires: ${t.requires.join(", ")}` : "";
    const tags = t.tags.length ? `  [${t.tags.join(", ")}]` : "";
    console.log(`${t.id}  ${t.title}  (trials ${t.trials}, ${t.timeoutSeconds}s)${tags}${req}`);
  }
  for (const e of errors) console.log(`INVALID  ${e.message}`);
  console.log(`\nagents: ${ADAPTER_IDS.join(", ")}`);
  return errors.length > 0 ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
    return cmd || values.help ? 0 : 2;
  }
  try {
    switch (cmd) {
      case "run":
        return await cmdRun(values);
      case "report":
        return cmdReport(rest, values);
      case "validate":
        return await cmdValidate(values);
      case "list":
        return cmdList(values);
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function isEntryPoint(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
