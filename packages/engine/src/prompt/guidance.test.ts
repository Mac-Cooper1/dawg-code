/**
 * The tool guidance and the core instructions make claims about how the tools behave. These
 * tests hold each claim against the tools themselves, so a change to a tool that makes the prompt
 * wrong fails here.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createTestToolContext, type TestToolContext } from "../testing/context.ts";
import {
  bashTool,
  CORE_TOOLS,
  editTool,
  globTool,
  grepTool,
  readTool,
  taskStopTool,
  writeTool,
} from "../tools/index.ts";
import { INTERACTIVE_TOOLS } from "../tools/interactive/index.ts";
import { CORE_INSTRUCTIONS, renderToolGuidance } from "./index.ts";

const ALL = [...CORE_TOOLS, ...INTERACTIVE_TOOLS].map((t) => t.name);
const described = (name: string) => INTERACTIVE_TOOLS.find((t) => t.name === name)?.description;

function textOf(out: { content: { type: string; text?: string }[] }): string {
  return out.content.map((p) => p.text ?? "").join("\n");
}

describe("the guidance", () => {
  test("never names a tool the session does not have", () => {
    for (let mask = 0; mask < 1 << ALL.length; mask++) {
      const present = ALL.filter((_, i) => mask & (1 << i));
      const text = renderToolGuidance(present);
      for (const name of ALL) {
        if (present.includes(name)) continue;
        expect(text, `${present.join(",")} mentions ${name}`).not.toMatch(
          new RegExp(`\\b${name}\\b`),
        );
      }
    }
  });

  test("is empty without known tools and complete with all of them", () => {
    expect(renderToolGuidance([])).toBe("");
    expect(renderToolGuidance(["SomeMcpTool"])).toBe("");
    const full = renderToolGuidance(ALL);
    for (const heading of ["# Using the tools", "# Task list", "# Plan mode", "# Questions"]) {
      expect(full).toContain(heading);
    }
  });

  test("depends on which tools are present, not their order", () => {
    expect(renderToolGuidance([...ALL].reverse())).toBe(renderToolGuidance(ALL));
  });

  test("the core instructions name no tool, so they hold for any tool set", () => {
    for (const name of ALL) expect(CORE_INSTRUCTIONS).not.toMatch(new RegExp(`\\b${name}\\b`));
  });
});

describe("claims the prompt makes about the tools", () => {
  test("tool descriptions say the same things", () => {
    // Read shows line-number prefixes that are not part of the file.
    expect(readTool.description).toMatch(/line number/);
    // Edit and Write need a prior Read, and refuse a file changed since.
    expect(editTool.description).toMatch(/Read the file first in this session/);
    expect(editTool.description).toMatch(/changed on disk after you read it/);
    expect(writeTool.description).toMatch(/first Read all of it in this session/);
    // Bash keeps its directory but not its environment; long output is saved to a file.
    expect(bashTool.description).toMatch(/working directory carries over/);
    expect(bashTool.description).toMatch(/Environment variables.*do not carry over/);
    expect(bashTool.description).toMatch(/full text is saved to a file/);
    expect(bashTool.description).toMatch(/run_in_background/);
    expect(bashTool.description).toMatch(/no input/);
    expect(taskStopTool.description).toMatch(/run_in_background/);
    expect(globTool.description).toMatch(/Find files by name/);
    expect(grepTool.description).toMatch(/Search file contents/);
    // The task list is replaced whole, with one task in progress at a time.
    expect(described("TodoWrite")).toMatch(/whole list every time: it replaces/);
    expect(described("TodoWrite")).toMatch(/exactly one task in_progress/);
    // Plan mode changes nothing; a rejected plan comes back with feedback.
    expect(described("EnterPlanMode")).toMatch(/not change anything/);
    expect(described("ExitPlanMode")).toMatch(/if not, you get their feedback and keep planning/);
    expect(described("AskUserQuestion")).toMatch(/multiple-choice/);
  });

  describe("and the tools behave that way", () => {
    let t: TestToolContext;
    afterEach(async () => {
      await t.cleanup();
    });

    test("Edit refuses a file not read in this session; after a Read it works", async () => {
      t = await createTestToolContext();
      const file = path.join(t.ctx.cwd, "a.txt");
      await writeFile(file, "one\ntwo\n");
      const refused = await editTool.execute(
        { file_path: file, old_string: "two", new_string: "three" },
        t.ctx,
      );
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toMatch(/not read/);
      const read = await readTool.execute({ file_path: file }, t.ctx);
      // Read's lines carry a number and "→" before the text.
      expect(textOf(read)).toMatch(/^1→one$/m);
      const edited = await editTool.execute(
        { file_path: file, old_string: "two", new_string: "three" },
        t.ctx,
      );
      expect(edited.isError).not.toBe(true);
    });

    test("Edit refuses a file that changed on disk since it was read", async () => {
      t = await createTestToolContext();
      const file = path.join(t.ctx.cwd, "a.txt");
      await writeFile(file, "one\n");
      await readTool.execute({ file_path: file }, t.ctx);
      await writeFile(file, "one\nchanged elsewhere\n");
      const refused = await editTool.execute(
        { file_path: file, old_string: "one", new_string: "1" },
        t.ctx,
      );
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toMatch(/changed on disk/);
    });

    test("Write over an existing file needs all of it read first", async () => {
      t = await createTestToolContext();
      const file = path.join(t.ctx.cwd, "b.txt");
      await writeFile(file, "1\n2\n3\n4\n");
      expect((await writeTool.execute({ file_path: file, content: "x\n" }, t.ctx)).isError).toBe(
        true,
      );
      await readTool.execute({ file_path: file, limit: 2 }, t.ctx);
      expect((await writeTool.execute({ file_path: file, content: "x\n" }, t.ctx)).isError).toBe(
        true,
      );
      await readTool.execute({ file_path: file }, t.ctx);
      expect(
        (await writeTool.execute({ file_path: file, content: "x\n" }, t.ctx)).isError,
      ).not.toBe(true);
    });

    test("Bash keeps the directory between calls but not the environment", async () => {
      t = await createTestToolContext();
      await mkdir(path.join(t.ctx.cwd, "sub"));
      await bashTool.execute({ command: "cd sub && export DAWG_PROBE=set" }, t.ctx);
      const out = await bashTool.execute({ command: 'pwd; echo "probe=$DAWG_PROBE"' }, t.ctx);
      const text = textOf(out);
      expect(text).toMatch(/sub\n/);
      expect(text).toMatch(/^probe=$/m);
    });

    test("Bash commands get no input", async () => {
      t = await createTestToolContext();
      const out = await bashTool.execute({ command: 'read line; echo "got:$line"' }, t.ctx);
      expect(textOf(out)).toContain("got:");
    });

    test("long Bash output is cut and the full text saved to a file named in the result", async () => {
      t = await createTestToolContext({ limits: { bashMaxOutputChars: 2_000 } });
      const out = await bashTool.execute({ command: "seq 1 5000" }, t.ctx);
      const text = textOf(out);
      expect(text).toMatch(/saved in \S+/);
      expect(t.saved.length).toBeGreaterThan(0);
    });
  });
});
