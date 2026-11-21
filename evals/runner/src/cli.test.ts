import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FIXTURES, TASKS, tempDir } from "./__fixtures__/paths.ts";
import { main } from "./cli.ts";
import { readResultFiles } from "./results.ts";

let dir: string;
let cleanup: () => void;
let out: string[];
beforeEach(() => {
  ({ dir, cleanup } = tempDir());
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

test("report writes the scoreboard", async () => {
  const files = [
    join(FIXTURES, "report", "2026-11-20-opencode-qwen3.8-27b.jsonl"),
    join(FIXTURES, "report", "2026-11-20-claude-code-qwen3.8-27b.jsonl"),
  ];
  const target = join(dir, "report.md");
  expect(await main(["report", ...files, "--out", target])).toBe(0);
  expect(readFileSync(target, "utf8")).toBe(
    readFileSync(join(FIXTURES, "report", "expected.md"), "utf8"),
  );
});

test("run --agent reference writes rows without any endpoint", async () => {
  const code = await main([
    "run",
    "--agent",
    "reference",
    "--tasks",
    "edit-greeting",
    "--trials",
    "1",
    "--tasks-dir",
    TASKS,
    "--results-dir",
    dir,
  ]);
  expect(code).toBe(0);
  expect(out.join("\n")).toMatch(/PASS\s+edit-greeting #1/);
  const file = out.find((l) => l.startsWith("results: "))?.slice("results: ".length) as string;
  expect(file).toMatch(/-reference-none\.jsonl$/);
  expect(readResultFiles([file]).rows[0]?.status).toBe("pass");
});

test("validate and list over the fixture tasks", async () => {
  expect(await main(["validate", "--tasks-dir", TASKS])).toBe(0);
  expect(out.join("\n")).toContain("all 3 tasks behave");
  out.length = 0;
  expect(await main(["list", "--tasks-dir", TASKS])).toBe(0);
  expect(out[0]).toMatch(/^edit-greeting {2}Change the greeting {2}\(trials 2, 30s\)/);
});

test("usage errors exit 2", async () => {
  expect(await main([])).toBe(2);
  expect(await main(["run"])).toBe(2);
  expect(
    await main([
      "run",
      "--agent",
      "pi",
      "--tasks-dir",
      TASKS,
      "--model",
      "m",
      "--endpoint",
      "http://x.example/api",
    ]),
  ).toBe(2);
  expect(out.join("\n")).toContain("must be an http(s) URL ending in /v1");
  expect(await main(["bogus"])).toBe(2);
  expect(await main(["run", "--nope"])).toBe(2);
});
