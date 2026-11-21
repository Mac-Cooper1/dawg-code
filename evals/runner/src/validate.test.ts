import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { copyTask, TASKS, tempDir } from "./__fixtures__/paths.ts";
import { validateTasks } from "./validate.ts";

test("every fixture task: noop fails and reference passes", async () => {
  const lines: string[] = [];
  const res = await validateTasks({ tasksDir: TASKS, repoRoot: TASKS, log: (l) => lines.push(l) });
  expect(res.surprises).toEqual([]);
  expect(res.ok).toBe(true);
  expect(res.taskCount).toBe(3);
  expect(res.artifactsRoot).toBeNull();
  expect(lines).toEqual([
    "ok        edit-greeting",
    "ok        needs-mcp",
    "ok        setup-and-delete",
  ]);
});

test("a checker that passes the untouched fixture, a broken solution and an invalid task are surprises", async () => {
  const { dir: root, cleanup } = tempDir();
  try {
    const lax = copyTask(root, join(TASKS, "edit-greeting"), "edit-greeting");
    writeFileSync(join(lax, "check.sh"), "exit 0\n");
    const broken = copyTask(root, join(TASKS, "setup-and-delete"), "setup-and-delete");
    rmSync(join(broken, "solution.sh"));
    const invalid = copyTask(root, join(TASKS, "needs-mcp"), "needs-mcp");
    writeFileSync(join(invalid, "task.yaml"), "id: needs-mcp\ntitle: t\n");

    const res = await validateTasks({ tasksDir: root, repoRoot: root });
    expect(res.ok).toBe(false);
    expect(res.surprises).toHaveLength(3);
    expect(res.surprises[0]).toMatch(/^invalid: task "needs-mcp", field "prompt"/);
    expect(res.surprises[1]).toMatch(/^edit-greeting: noop: expected fail, got pass/);
    expect(res.surprises[2]).toMatch(/^setup-and-delete: reference: expected pass, got fail/);
    expect(existsSync(res.artifactsRoot as string)).toBe(true);
    rmSync(res.artifactsRoot as string, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});
