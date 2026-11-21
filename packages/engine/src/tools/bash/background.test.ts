import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionStateBag, ToolLimits, ToolOutput } from "../../contracts/tools.ts";
import { createStateBag, createTestToolContext } from "../../testing/context.ts";
import { processAlive } from "../exec/process.ts";
import { processesMatching, readPid, survivors } from "../exec/test-support.ts";
import { type BackgroundTaskInfo, getBackgroundTasks } from "./background.ts";
import { type BashInput, createBashTool } from "./bash.ts";
import { taskOutputTool, taskStopTool } from "./task-tools.ts";

const MARK = "4802";

let root: string;
let state: SessionStateBag;
let cleanups: (() => Promise<void>)[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-bg-test-"));
  state = createStateBag();
});
afterEach(async () => {
  await getBackgroundTasks(state).stopAll();
  await Promise.all(cleanups.map((cleanup) => cleanup()));
  cleanups = [];
  await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  expect(await processesMatching(`sleep ${MARK}`)).toEqual([]);
});

const bash = createBashTool({ killGraceMs: 300 });

/** A context for this test's session, removed again after the test. */
async function context(limits?: Partial<ToolLimits>) {
  const test = await createTestToolContext({ cwd: root, state, limits });
  cleanups.push(test.cleanup);
  return test;
}

async function start(input: Omit<BashInput, "run_in_background">) {
  const test = await context();
  const out = await bash.execute({ ...input, run_in_background: true }, test.ctx);
  const display = out.display;
  if (display?.kind !== "command" || !display.backgroundTaskId || !display.outputPath) {
    throw new Error(`not started in the background: ${text(out)}`);
  }
  return { out, id: display.backgroundTaskId, outputPath: display.outputPath, ...test };
}

function text(out: ToolOutput): string {
  const part = out.content[0];
  return part?.type === "text" ? part.text : "";
}

describe("Bash run_in_background", () => {
  it("returns at once with a task id and the output file", async () => {
    const started = Date.now();
    const { out, id, outputPath, saved } = await start({ command: `sleep ${MARK}` });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.isError).toBeFalsy();
    expect(id).toBe("bash-1");
    expect(saved.map((s) => s.path)).toEqual([outputPath]);
    expect(text(out)).toContain(`Started in the background as task ${id}.`);
    expect(text(out)).toContain(outputPath);
    expect(out.display).toMatchObject({ exitCode: null, durationMs: null, cwd: root });
    expect(
      getBackgroundTasks(state)
        .running()
        .map((t) => t.id),
    ).toEqual([id]);
  });

  it("collects output in the file and reports the finish", async () => {
    const tasks = getBackgroundTasks(state);
    const finished: BackgroundTaskInfo[] = [];
    const unsubscribe = tasks.onFinished((info) => finished.push(info));
    const { id, outputPath } = await start({
      command: String.raw`echo start; sleep 0.2; printf '\033[32mgreen\033[0m\n' >&2; exit 2`,
      description: "Print and fail",
    });
    const info = await tasks.waitFor(id, 5000);
    unsubscribe();
    expect(info).toMatchObject({ status: "failed", exitCode: 2, description: "Print and fail" });
    expect(await readFile(outputPath, "utf8")).toBe("start\ngreen\n");
    expect(finished.map((f) => f.id)).toEqual([id]);
    expect(tasks.takeFinished().map((f) => f.id)).toEqual([id]);
    expect(tasks.takeFinished()).toEqual([]);
    expect(tasks.recentOutput(id, 100)).toBe("start\ngreen\n");
  });

  it("starts in the shell's current directory without changing it", async () => {
    const test = await context();
    await bash.execute({ command: "mkdir -p sub && cd sub" }, test.ctx);
    const { id, outputPath } = await start({ command: "pwd; cd /" });
    await getBackgroundTasks(state).waitFor(id, 5000);
    expect((await readFile(outputPath, "utf8")).trim()).toBe(path.join(root, "sub"));
    const after = await bash.execute({ command: "pwd" }, (await context()).ctx);
    expect(text(after)).toBe(path.join(root, "sub"));
  });

  it("ends a task when its shell exits, even if an escaped process holds the output", async () => {
    const { id, outputPath } = await start({
      command: `perl -MPOSIX -e 'POSIX::setsid(); open(F, ">", "d.pid"); print F $$; close F; exec "sleep", "${MARK}"' & sleep 0.2; echo started`,
    });
    const escaped = await readPid(path.join(root, "d.pid"));
    try {
      const info = await getBackgroundTasks(state).waitFor(id, 5000);
      expect(info?.status).toBe("completed");
      expect(await readFile(outputPath, "utf8")).toBe("started\n");
    } finally {
      if (processAlive(escaped)) process.kill(escaped, "SIGKILL");
    }
  });

  it("stops a task at its time limit", async () => {
    const { id } = await start({ command: `sleep ${MARK}`, timeout: 300 });
    const info = await getBackgroundTasks(state).waitFor(id, 5000);
    expect(info).toMatchObject({ status: "stopped", stopReason: "time_limit" });
  });
});

describe("stopping background tasks", () => {
  it("stops one task and everything it started", async () => {
    const { id } = await start({
      command: `sh -c 'sleep ${MARK} & echo $! > gc.pid; wait' & echo $! > c.pid; wait`,
    });
    const pids = [
      await readPid(path.join(root, "c.pid")),
      await readPid(path.join(root, "gc.pid")),
    ];
    const info = await getBackgroundTasks(state).stop(id);
    expect(info).toMatchObject({ status: "stopped", stopReason: "requested" });
    expect(await survivors(pids)).toEqual([]);
  });

  it("stops every task at the end of the session", async () => {
    const first = await start({ command: `sleep ${MARK} & echo $! > a.pid; wait` });
    const second = await start({ command: `sleep ${MARK} & echo $! > b.pid; wait` });
    const pids = [await readPid(path.join(root, "a.pid")), await readPid(path.join(root, "b.pid"))];
    expect(pids.every(processAlive)).toBe(true);
    const tasks = getBackgroundTasks(state);
    await tasks.stopAll();
    expect(await survivors(pids)).toEqual([]);
    expect(tasks.get(first.id)).toMatchObject({ status: "stopped", stopReason: "session_end" });
    expect(tasks.get(second.id)).toMatchObject({ status: "stopped", stopReason: "session_end" });
    expect(tasks.running()).toEqual([]);
  });
});

describe("TaskStop", () => {
  it("stops a running task by task_id", async () => {
    const { id } = await start({ command: `sleep ${MARK}`, description: "Long sleep" });
    const { ctx } = await context();
    const out = await taskStopTool.execute({ task_id: id }, ctx);
    expect(out.isError).toBeFalsy();
    expect(text(out)).toBe(`Stopped task ${id} (sleep ${MARK}).`);
    expect(out.display).toMatchObject({ kind: "command", backgroundTaskId: id });
    expect(getBackgroundTasks(state).get(id)?.status).toBe("stopped");
  });

  it("accepts the older shell_id input", async () => {
    const { id } = await start({ command: `sleep ${MARK}` });
    const out = await taskStopTool.execute({ shell_id: id }, (await context()).ctx);
    expect(out.isError).toBeFalsy();
    expect(getBackgroundTasks(state).get(id)?.status).toBe("stopped");
  });

  it("lists the running tasks when the id is unknown", async () => {
    const { id } = await start({ command: `sleep ${MARK}`, description: "Watch the build" });
    const out = await taskStopTool.execute({ task_id: "bash-99" }, (await context()).ctx);
    expect(out.isError).toBe(true);
    expect(text(out)).toBe(
      `There is no background task bash-99. Running background tasks:\n- ${id}: Watch the build`,
    );
  });

  it("says when the task had already ended", async () => {
    const { id } = await start({ command: "true" });
    await getBackgroundTasks(state).waitFor(id, 5000);
    const out = await taskStopTool.execute({ task_id: id }, (await context()).ctx);
    expect(out.isError).toBeFalsy();
    expect(text(out)).toMatch(new RegExp(`^Task ${id} had already ended: it exited with code 0`));
  });

  it("asks for no permission and has the documented inputs", async () => {
    const { ctx } = await context();
    expect(taskStopTool.permission({ task_id: "x" }, ctx)).toEqual({ kind: "none" });
    expect(Object.keys((taskStopTool.inputSchema as { properties: object }).properties)).toEqual([
      "task_id",
      "shell_id",
    ]);
  });
});

describe("TaskOutput", () => {
  it("returns new output since the last check", async () => {
    const { id } = await start({
      command: "echo one; sleep 0.3; echo two; sleep 30",
    });
    const { ctx } = await context();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const first = await taskOutputTool.execute({ task_id: id }, ctx);
    expect(text(first)).toMatch(new RegExp(`^Task ${id} is still running .*\\nNew output:\\none$`));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const second = await taskOutputTool.execute({ task_id: id }, ctx);
    expect(text(second)).toMatch(/New output:\ntwo$/);
    const third = await taskOutputTool.execute({ task_id: id }, ctx);
    expect(text(third)).toContain("No new output since the last check.");
  });

  it("waits for the task to end with block", async () => {
    const { id } = await start({ command: "sleep 0.3; echo finished" });
    const out = await taskOutputTool.execute(
      { task_id: id, block: true, timeout: 5000 },
      (await context()).ctx,
    );
    expect(text(out)).toMatch(
      new RegExp(`^Task ${id} has ended: it exited with code 0 after .*\\nNew output:\\nfinished$`),
    );
    expect(out.display).toMatchObject({ exitCode: 0 });
  });

  it("shortens a large amount of new output to its head and tail", async () => {
    const { id, outputPath } = await start({ command: "seq 1 20000" });
    await getBackgroundTasks(state).waitFor(id, 5000);
    const { ctx } = await context({ bashMaxOutputChars: 200 });
    const out = await taskOutputTool.execute({ task_id: id }, ctx);
    expect(text(out)).toContain("New output:\n1\n2\n3\n");
    expect(text(out)).toContain("bytes omitted");
    expect(text(out)).toContain(outputPath);
    expect(text(out).trimEnd().endsWith("20000")).toBe(true);
  });

  it("reports an unknown task as an error", async () => {
    const out = await taskOutputTool.execute({ task_id: "nope" }, (await context()).ctx);
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("No background tasks are running.");
  });
});
