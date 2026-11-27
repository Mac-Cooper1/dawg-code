/**
 * Auto memory on a whole engine with the real prompt assembler: MEMORY.md in the prefix within
 * its cap, the prefix unchanged while the model writes to it, the next session seeing what was
 * written, the file tools free in the memory folder only, and `/memory`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { text, toolCall } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandRegistry } from "../commands/index.ts";
import { memoryDirectory } from "../memory/index.ts";
import { createPromptAssembler } from "../prompt/index.ts";
import { type Harness, type HarnessOptions, startHarness } from "./__fixtures__/harness.ts";
import type { SessionRuntime } from "./session.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const prompt = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

async function withMemory(options: HarnessOptions & { index?: string } = {}) {
  const harness = await startHarness({
    ...options,
    engine: { assembler: createPromptAssembler(), autoMemory: true, ...options.engine },
  });
  h = harness;
  const dir = await memoryDirectory(harness.storeRoot, harness.project);
  if (options.index !== undefined) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "MEMORY.md"), options.index);
  }
  return { h: harness, dir };
}

/** The system message of chat request `n` (from 0). */
function systemOf(harness: Harness, n: number): string {
  const first = harness.mock.messages(n)[0] as { role: string; content: string };
  expect(first.role).toBe("system");
  return first.content;
}

describe("auto memory", () => {
  it("loads the start of MEMORY.md into the prefix, within the cap", async () => {
    const lines = Array.from({ length: 230 }, (_, i) => `- fact ${i + 1}`);
    const { h, dir } = await withMemory({ index: lines.join("\n"), script: [text("Hi.")] });
    const session = await h.engine.createSession({ cwd: h.project });
    expect(session.memory).toMatchObject({ directory: dir, loadedLines: 200, truncated: true });
    expect(session.prefix.system.content).toContain(`# Memory`);
    expect(session.prefix.system.content).toContain(dir);
    expect(session.prefix.system.content).toContain("- fact 200");
    expect(session.prefix.system.content).not.toContain("- fact 201");
    await session.run(prompt("hello"));
    expect(systemOf(h, 0)).toBe(session.prefix.system.content);
    // The context breakdown counts it with the instruction files.
    expect(session.contextUsage().breakdown.instructions).toBeGreaterThan(0);
  });
});

describe("auto memory, writing", () => {
  async function remember(options: { settings?: string } = {}) {
    const files: Record<string, string> = {};
    if (options.settings !== undefined) files[".dawg/settings.json"] = options.settings;
    const harness = await startHarness({
      files,
      engine: { assembler: createPromptAssembler(), autoMemory: true },
      script: [],
    });
    h = harness;
    const dir = await memoryDirectory(harness.storeRoot, harness.project);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "MEMORY.md"), "- [Style](style.md): tabs\n");
    return { h: harness, dir, index: path.join(dir, "MEMORY.md") };
  }

  async function start(harness: Harness): Promise<SessionRuntime> {
    // Nobody can answer a prompt here: anything that would ask is refused instead.
    return harness.engine.createSession({
      cwd: harness.project,
      capabilities: { permissionPrompts: false },
    });
  }

  it("lets the file tools keep the memory folder without asking, and nothing else", async () => {
    const { h, dir, index } = await remember();
    const session = await start(h);
    const before = session.prefix.system.content;
    const outside = path.join(h.root, "elsewhere.md");
    h.mock.addReplies(
      toolCall("Read", { file_path: index }),
      toolCall("Edit", {
        file_path: index,
        old_string: "- [Style](style.md): tabs\n",
        new_string: "- [Style](style.md): tabs\n- [Deploys](deploys.md): Fridays are off limits\n",
      }),
      toolCall("Write", {
        file_path: path.join(dir, "deploys.md"),
        content: "No deploys on Fridays.\n",
      }),
      toolCall("Write", { file_path: outside, content: "x\n" }),
      text("Saved."),
    );
    await session.run(prompt("Remember: no deploys on Fridays"));

    const outcomes = h
      .ofType(session.id, "tool.finished")
      .map((e) => [e.payload.toolName, e.payload.outcome]);
    expect(outcomes).toEqual([
      ["Read", "success"],
      ["Edit", "success"],
      ["Write", "success"],
      ["Write", "denied"],
    ]);
    expect(h.ofType(session.id, "permission.requested")).toEqual([]);
    expect(await readFile(index, "utf8")).toContain("Fridays are off limits");

    // Every request this session sent has the prefix it started with.
    expect(session.prefix.system.content).toBe(before);
    for (let n = 0; n < h.mock.chatRequests.length; n++) expect(systemOf(h, n)).toBe(before);
    expect(before).not.toContain("Fridays");

    // The next session sees it.
    const next = await start(h);
    expect(next.prefix.system.content).toContain("Fridays are off limits");
  });

  it("stays as it was through a compaction", async () => {
    const { h, index } = await remember();
    const session = await start(h);
    const before = session.prefix.system.content;
    await writeFile(index, "- changed meanwhile\n");
    await session.compact();
    expect(session.prefix.system.content).toBe(before);
  });

  it("is off when a settings file says autoMemoryEnabled: false", async () => {
    const { h, index } = await remember({ settings: JSON.stringify({ autoMemoryEnabled: false }) });
    const session = await start(h);
    expect(session.memory).toBeNull();
    expect(session.prefix.system.content).not.toContain("# Memory");
    h.mock.addReplies(toolCall("Write", { file_path: index, content: "x\n" }), text("No."));
    await session.run(prompt("Try"));
    expect(h.ofType(session.id, "tool.finished")[0]?.payload.outcome).toBe("denied");
  });

  it("is shared by a worktree session of the project", async () => {
    const { h, dir } = await remember();
    await mkdir(path.join(h.project, ".git", "worktrees", "wt"), { recursive: true });
    const worktree = path.join(h.project, ".dawg", "worktrees", "wt");
    await mkdir(worktree, { recursive: true });
    await writeFile(
      path.join(worktree, ".git"),
      `gitdir: ${path.join(h.project, ".git", "worktrees", "wt")}\n`,
    );
    const session = await h.engine.createSession({ cwd: worktree, projectDir: h.project });
    expect(session.memory?.directory).toBe(dir);
  });

  it("is off unless the engine turns it on", async () => {
    h = await startHarness({ engine: { assembler: createPromptAssembler() } });
    const session = await h.engine.createSession({ cwd: h.project });
    expect(session.memory).toBeNull();
    expect(session.prefix.system.content).not.toContain("# Memory");
  });
});

describe("/memory", () => {
  it("makes the folder and MEMORY.md, and lists them with the instruction files", async () => {
    const harness = await startHarness({
      files: { "CLAUDE.md": "Use tabs.\n" },
      engine: { assembler: createPromptAssembler(), autoMemory: true },
    });
    h = harness;
    const dir = await memoryDirectory(harness.storeRoot, harness.project);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "testing.md"), "Run make test.\n");
    const session = await harness.engine.createSession({ cwd: harness.project });
    const result = await createCommandRegistry().run("memory", {
      args: "",
      session,
      engine: harness.engine,
      homeDir: harness.home,
      settingsFlags: undefined,
      capabilities: {},
      describeEndpoint: () => null,
    });
    expect(result.kind).toBe("output");
    const out = result.kind === "output" ? result.text : "";
    expect(await readFile(path.join(dir, "MEMORY.md"), "utf8")).toBe("");
    expect(out).toContain("MEMORY.md: the index");
    expect(out).toContain("testing.md");
    expect(out).toContain("CLAUDE.md (the project's)");
    expect(out).toContain("~/.claude/CLAUDE.md (yours, for every project; not made yet)");
  });
});
