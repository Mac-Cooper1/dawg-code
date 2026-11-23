import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  FAKE_AGENT,
  FAKE_PROXY,
  HANG_AGENT,
  SLOW_TASKS,
  TASKS,
  tempDir,
} from "./__fixtures__/paths.ts";
import { createAdapter } from "./adapters/index.ts";
import { readResultFiles } from "./results.ts";
import { type RunOptions, runSuite } from "./run.ts";
import { loadTask, loadTasks } from "./task.ts";

let dir: string;
let cleanup: () => void;
beforeEach(() => {
  ({ dir, cleanup } = tempDir());
});
afterEach(() => cleanup());

function opts(overrides: Partial<RunOptions> & Pick<RunOptions, "adapter" | "tasks">): RunOptions {
  return {
    model: "none",
    trials: 1,
    repoRoot: dir,
    resultsDir: join(dir, "results"),
    artifactsRoot: join(dir, "results", "tmp"),
    tempParent: dir,
    now: () => new Date("2026-11-20T12:00:00Z"),
    ...overrides,
  };
}

const workspacesLeft = () => readdirSync(dir).filter((n) => n.startsWith("dawg-eval-"));

describe("runSuite with the built-in adapters", () => {
  test("reference passes and noop fails on every fixture task", async () => {
    const { tasks } = loadTasks(TASKS);
    const ref = await runSuite(opts({ adapter: createAdapter("reference"), tasks }));
    expect(ref.rows.map((r) => [r.task, r.status])).toEqual([
      ["edit-greeting", "pass"],
      ["needs-mcp", "pass"],
      ["setup-and-delete", "pass"],
    ]);
    const noop = await runSuite(opts({ adapter: createAdapter("noop"), tasks }));
    expect(noop.rows.map((r) => [r.task, r.status])).toEqual([
      ["edit-greeting", "fail"],
      ["needs-mcp", "fail"],
      ["setup-and-delete", "fail"],
    ]);
    expect(noop.rows.every((r) => r.check_exit_code !== 0)).toBe(true);
    // Workspaces are cleaned up when --keep is not given.
    expect(workspacesLeft()).toEqual([]);
  });

  test("rows are appended to <date>-<agent>-<model>.jsonl with artefacts per run", async () => {
    const tasks = [loadTask(join(TASKS, "setup-and-delete"))];
    const res = await runSuite(opts({ adapter: createAdapter("reference"), tasks, trials: 2 }));
    expect(res.resultsFile).toBe(join(dir, "results", "2026-11-20-reference-none.jsonl"));
    const { rows, errors } = readResultFiles([res.resultsFile as string]);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.trial)).toEqual([1, 2]);
    const row = rows[0];
    expect(row?.status).toBe("pass");
    expect(row?.endpoint).toBeNull();
    expect(row?.artifacts_dir).toMatch(
      /^results\/tmp\/20261120T120000Z-reference-setup-and-delete-t1-/,
    );
    const art = join(dir, row?.artifacts_dir as string);
    const diff = readFileSync(join(art, "diff.patch"), "utf8");
    expect(diff).toContain("+++ b/answer.txt");
    expect(diff).toContain("deleted file mode"); // solution.sh removed obsolete.txt
    expect(existsSync(join(art, "check.stdout.log"))).toBe(true);
    expect(existsSync(join(art, "setup.stdout.log"))).toBe(true);
  });

  test("tasks whose requirements the agent lacks are recorded as skipped", async () => {
    const tasks = [loadTask(join(TASKS, "needs-mcp")), loadTask(join(TASKS, "edit-greeting"))];
    const res = await runSuite(
      opts({
        adapter: createAdapter("command", { agentCmd: "true" }),
        tasks,
        resultsDir: null,
        endpoint: {
          url: "http://example.invalid/v1",
          proxyCommand: [process.execPath, FAKE_PROXY],
        },
        model: "m",
      }),
    );
    const skipped = res.rows.find((r) => r.task === "needs-mcp");
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.reason).toBe("agent lacks: mcp");
    expect(skipped?.trial).toBe(0);
    expect(res.rows.find((r) => r.task === "edit-greeting")?.status).toBe("fail");
  });

  test("check.sh is killed after its time limit and the run fails", async () => {
    const tasks = [loadTask(join(SLOW_TASKS, "slow-check"))];
    const started = Date.now();
    const res = await runSuite(
      opts({ adapter: createAdapter("noop"), tasks, checkTimeoutMs: 500 }),
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    const row = res.rows[0];
    expect(row?.status).toBe("fail");
    expect(row?.check_timed_out).toBe(true);
    expect(row?.reason).toBe("check.sh timed out");
  });

  test("--keep keeps the workspace of failed runs only", async () => {
    const tasks = [loadTask(join(TASKS, "edit-greeting"))];
    const pass = await runSuite(opts({ adapter: createAdapter("reference"), tasks, keep: true }));
    expect(pass.rows[0]?.workspace).toBeNull();
    const fail = await runSuite(opts({ adapter: createAdapter("noop"), tasks, keep: true }));
    const kept = fail.rows[0]?.workspace as string;
    expect(kept).toBeTruthy();
    expect(readFileSync(join(kept, "workspace", "greeting.txt"), "utf8")).toBe("hello\n");
    rmSync(kept, { recursive: true, force: true });
  });

  test("--concurrency runs trials in parallel and still records every one", async () => {
    const { tasks } = loadTasks(TASKS);
    const res = await runSuite(
      opts({ adapter: createAdapter("reference"), tasks, trials: 2, concurrency: 3 }),
    );
    expect(res.rows).toHaveLength(6);
    expect(res.rows.every((r) => r.status === "pass")).toBe(true);
    expect(new Set(res.rows.map((r) => r.run_id)).size).toBe(6);
    expect(workspacesLeft()).toEqual([]);
  });

  test("an adapter that needs an endpoint refuses to run without one", async () => {
    const tasks = [loadTask(join(TASKS, "edit-greeting"))];
    await expect(runSuite(opts({ adapter: createAdapter("pi"), tasks }))).rejects.toThrow(
      /needs an endpoint/,
    );
  });
});

describe("runSuite with the command adapter and a (fake) recording proxy", () => {
  test("end to end: proxy records feed the metrics; the agent sees only the dummy key", async () => {
    process.env.FAKE_UPSTREAM_KEY = "sk-real-secret-never-written";
    try {
      const tasks = [loadTask(join(TASKS, "edit-greeting"))];
      const report = join(dir, "agent-report.json");
      const res = await runSuite(
        opts({
          adapter: createAdapter("command", {
            agentCmd: `${process.execPath} ${FAKE_AGENT} {openai_base_url} {model} {prompt} ${report}`,
          }),
          tasks,
          model: "Qwen/Qwen3.8-27B",
          endpoint: {
            url: "https://user:pw@upstream.example/v1",
            keyEnv: "FAKE_UPSTREAM_KEY",
            proxyCommand: [process.execPath, FAKE_PROXY],
          },
          label: "hosted, bf16",
        }),
      );
      const row = res.rows[0];
      expect(row?.status).toBe("pass");
      expect(row?.agent_exit_code).toBe(0);
      expect(row?.endpoint).toBe("https://upstream.example/v1");
      expect(row?.label).toBe("hosted, bf16");
      expect(row?.metrics).toEqual({
        requests: 2,
        prefix_tokens: 100,
        prompt_tokens: 300,
        completion_tokens: 20,
        tool_calls: 2,
        malformed_tool_calls: 1,
        cache_reuse_ratio: 90 / 200,
        failed_edits: null,
        invalid_records: 0,
      });

      const seen = JSON.parse(readFileSync(report, "utf8"));
      expect(seen.prompt).toBe(tasks[0]?.prompt);
      expect(seen.home).toMatch(/dawg-eval-edit-greeting-.*\/home$/);
      expect(seen.cwd).toMatch(/dawg-eval-edit-greeting-.*\/workspace$/);
      expect(seen.openaiKey).toBe("dawg-eval-dummy-key");
      expect(seen.envKeys).not.toContain("FAKE_UPSTREAM_KEY");

      // The proxy was told the env var NAME; the key value is written nowhere.
      const art = join(dir, row?.artifacts_dir as string);
      const records = readFileSync(join(art, "proxy.jsonl"), "utf8");
      expect(records).toContain('"key_env":"FAKE_UPSTREAM_KEY"');
      expect(records).toContain("Bearer dawg-eval-dummy-key");
      const everything = [
        readFileSync(res.resultsFile as string, "utf8"),
        records,
        ...readdirSync(art).map((f) => readFileSync(join(art, f), "utf8")),
      ].join("\n");
      expect(everything).not.toContain("sk-real-secret-never-written");
      expect(everything).not.toContain("user:pw");
    } finally {
      delete process.env.FAKE_UPSTREAM_KEY;
    }
  });

  test("an agent that hangs is killed at the task timeout and recorded as timed out", async () => {
    const tasks = [loadTask(join(TASKS, "edit-greeting"))];
    const res = await runSuite(
      opts({
        adapter: createAdapter("command", { agentCmd: `bash ${HANG_AGENT} {artifacts}` }),
        tasks,
        model: "m",
        agentTimeoutMs: 600,
        endpoint: {
          url: "http://example.invalid/v1",
          proxyCommand: [process.execPath, FAKE_PROXY],
        },
      }),
    );
    const row = res.rows[0];
    expect(row?.agent_timed_out).toBe(true);
    expect(row?.status).toBe("fail");
    expect(row?.reason).toBe("agent timed out; check.sh failed");
    expect(row?.wall_ms).toBeLessThan(5000);
  });

  test("--timeout-scale stretches each task's own time limit", async () => {
    const task = loadTask(join(TASKS, "edit-greeting"));
    const reference = createAdapter("reference");
    const seen: number[] = [];
    const adapter = {
      ...reference,
      run: (ctx: Parameters<typeof reference.run>[0]) => {
        seen.push(ctx.timeoutMs);
        return reference.run(ctx);
      },
    };
    await runSuite(opts({ adapter, tasks: [task] }));
    await runSuite(opts({ adapter, tasks: [task], timeoutScale: 2.5 }));
    expect(seen).toEqual([task.timeoutSeconds * 1000, task.timeoutSeconds * 2500]);
  });

  test("a proxy that fails to start makes the run an error, not a fail", async () => {
    const tasks = [loadTask(join(TASKS, "edit-greeting"))];
    const res = await runSuite(
      opts({
        adapter: createAdapter("command", { agentCmd: "true" }),
        tasks,
        model: "m",
        endpoint: { url: "http://example.invalid/v1", proxyCommand: ["bash", "-c", "exit 7"] },
      }),
    );
    expect(res.rows[0]?.status).toBe("error");
    expect(res.rows[0]?.reason).toMatch(/recording proxy: exited before listening/);
    expect(workspacesLeft()).toEqual([]);
  });

  test("an agent binary that does not exist is an error", async () => {
    const tasks = [loadTask(join(TASKS, "edit-greeting"))];
    const res = await runSuite(
      opts({
        adapter: createAdapter("pi", { agentBin: "definitely-not-installed-pi" }),
        tasks,
        model: "m",
        endpoint: {
          url: "http://example.invalid/v1",
          proxyCommand: [process.execPath, FAKE_PROXY],
        },
      }),
    );
    expect(res.rows[0]?.status).toBe("error");
    expect(res.rows[0]?.reason).toMatch(/agent could not start: .*ENOENT/);
  });
});
