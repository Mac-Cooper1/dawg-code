import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { copyTask, TASKS, tempDir } from "./__fixtures__/paths.ts";
import { listTaskDirs, loadTask, loadTasks, TaskError } from "./task.ts";

describe("loadTask", () => {
  test("loads a valid task with defaults filled in", () => {
    const t = loadTask(join(TASKS, "setup-and-delete"));
    expect(t.id).toBe("setup-and-delete");
    expect(t.prompt).toContain("uppercased");
    expect(t.timeoutSeconds).toBe(900);
    expect(t.trials).toBe(3);
    expect(t.requires).toEqual([]);
    expect(t.setupScript).toBe(join(TASKS, "setup-and-delete", "setup.sh"));
    expect(t.solutionScript).toBe(join(TASKS, "setup-and-delete", "solution.sh"));
  });

  test("reads explicit fields", () => {
    const t = loadTask(join(TASKS, "edit-greeting"));
    expect(t.timeoutSeconds).toBe(30);
    expect(t.trials).toBe(2);
    expect(t.tags).toEqual(["smoke", "text"]);
    expect(t.setupScript).toBeNull();
    expect(t.solutionScript).toBeNull();
    expect(loadTask(join(TASKS, "needs-mcp")).requires).toEqual(["mcp"]);
  });
});

describe("task validation errors name the task and the field", () => {
  let root: string;
  let cleanup: () => void;
  beforeEach(() => {
    ({ dir: root, cleanup } = tempDir());
  });
  afterEach(() => cleanup());

  const yamlWith = (id: string, yaml: string) => {
    const dir = copyTask(root, join(TASKS, "edit-greeting"), id);
    writeFileSync(join(dir, "task.yaml"), yaml);
    return dir;
  };
  const expectError = (dir: string, field: string | null, message: RegExp) => {
    let err: unknown;
    try {
      loadTask(dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TaskError);
    const te = err as TaskError;
    expect(te.field).toBe(field);
    expect(te.message).toMatch(message);
    expect(te.message).toContain(`task "${dir.split("/").pop()}"`);
  };

  test("id must match the directory name", () => {
    expectError(yamlWith("my-task", "id: other\ntitle: t\nprompt: p\n"), "id", /directory name/);
  });
  test("id must be kebab-case", () => {
    expectError(yamlWith("My_Task", "id: My_Task\ntitle: t\nprompt: p\n"), "id", /kebab-case/);
  });
  test("prompt is required", () => {
    expectError(yamlWith("no-prompt", "id: no-prompt\ntitle: t\n"), "prompt", /./);
  });
  test("timeout_seconds must be a positive integer", () => {
    const y = "id: bad-timeout\ntitle: t\nprompt: p\ntimeout_seconds: 1.5\n";
    expectError(yamlWith("bad-timeout", y), "timeout_seconds", /int/i);
  });
  test("trials must be a positive integer", () => {
    expectError(
      yamlWith("bad-trials", "id: bad-trials\ntitle: t\nprompt: p\ntrials: 0\n"),
      "trials",
      /./,
    );
  });
  test("tags must be a list of strings", () => {
    expectError(
      yamlWith("bad-tags", "id: bad-tags\ntitle: t\nprompt: p\ntags: smoke\n"),
      "tags",
      /./,
    );
  });
  test("requires entries must be strings", () => {
    const y = "id: bad-req\ntitle: t\nprompt: p\nrequires: [1]\n";
    expectError(yamlWith("bad-req", y), "requires.0", /./);
  });
  test("unknown fields are rejected (catches typos such as `timeout`)", () => {
    const y = "id: typo\ntitle: t\nprompt: p\ntimeout: 60\n";
    expectError(yamlWith("typo", y), null, /unknown field\(s\): timeout/);
  });
  test("invalid YAML", () => {
    expectError(yamlWith("bad-yaml", "id: [unclosed\n"), null, /not valid YAML/);
  });
  test("task.yaml must be a mapping", () => {
    expectError(yamlWith("a-list", "- a\n- b\n"), null, /mapping/);
  });
  test("missing task.yaml", () => {
    const dir = copyTask(root, join(TASKS, "edit-greeting"), "no-yaml");
    rmSync(join(dir, "task.yaml"));
    expectError(dir, null, /missing task.yaml/);
  });
  test.each([
    ["fixture", "fixture/"],
    ["solution", "solution/"],
    ["check.sh", "check.sh"],
  ])("missing %s", (path, field) => {
    const dir = copyTask(root, join(TASKS, "edit-greeting"), "edit-greeting");
    rmSync(join(dir, path), { recursive: true });
    expectError(dir, field, /missing/);
  });
});

describe("loadTasks", () => {
  test("skips directories starting with _ or . and sorts by id", () => {
    expect(listTaskDirs(TASKS)).toEqual(["edit-greeting", "needs-mcp", "setup-and-delete"]);
    const { tasks, errors } = loadTasks(TASKS);
    expect(errors).toEqual([]);
    expect(tasks.map((t) => t.id)).toEqual(["edit-greeting", "needs-mcp", "setup-and-delete"]);
  });

  test("collects errors instead of throwing, and honours the id filter", () => {
    const { dir: root, cleanup } = tempDir();
    try {
      copyTask(root, join(TASKS, "edit-greeting"), "edit-greeting");
      mkdirSync(join(root, "broken"));
      const all = loadTasks(root);
      expect(all.tasks.map((t) => t.id)).toEqual(["edit-greeting"]);
      expect(all.errors.map((e) => e.taskId)).toEqual(["broken"]);

      const some = loadTasks(root, ["missing-one", "edit-greeting"]);
      expect(some.tasks.map((t) => t.id)).toEqual(["edit-greeting"]);
      expect(some.errors[0]?.message).toMatch(/task "missing-one": no task directory/);
    } finally {
      cleanup();
    }
  });
});
