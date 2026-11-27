import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type ScriptReply, text, toolCall } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./__fixtures__/harness.ts";
import { EXIT } from "./exit-codes.ts";
import { editorCommand } from "./rewind.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function withTitles(replies: ScriptReply[]) {
  return {
    replies,
    lanes: { title: { match: { hasTools: false }, replies: [text("A title"), text("A title")] } },
  };
}

const TWO_TURNS = withTitles([
  toolCall("Read", { file_path: "notes.txt" }),
  toolCall("Edit", { file_path: "notes.txt", old_string: "original", new_string: "first" }),
  text("Now first."),
  toolCall("Edit", { file_path: "notes.txt", old_string: "first", new_string: "second" }),
  text("Now second."),
]);

describe("/rewind in interactive mode", () => {
  it("lists the points, restores files and conversation, and goes on in the fork", async () => {
    h = await startHarness({ script: TWO_TURNS });
    await writeFile(path.join(h.project, "notes.txt"), "original\n");
    const child = h.spawn(["--endpoint", h.mock.baseUrl, "--permission-mode", "acceptEdits"]);
    const stdin = child.process.stdin;
    if (stdin === null) throw new Error("no stdin");
    stdin.write("make it first\n");
    await child.waitForStdout("Now first.");
    stdin.write("make it second\n");
    await child.waitForStdout("Now second.");
    stdin.write("/rewind\n");
    await child.waitForStdout("Which point?");
    // Newest first: 2 is the first message.
    stdin.write("2\n");
    await child.waitForStdout("What to do?");
    stdin.write("1\n");
    await child.waitForStdout("The conversation goes on in session");
    stdin.end();
    const result = await child.exited;
    expect(result.code).toBe(EXIT.ok);
    const out = result.stdout;
    expect(out).toMatch(/1\. .* {2}make it second/);
    expect(out).toMatch(/2\. .* {2}make it first\n {7}changed notes\.txt/);
    expect(out).toContain("Only changes made by dawg's file tools");
    expect(out).toContain("put back notes.txt");
    expect(out).toContain("1. Restore files and conversation");
    expect(out).toContain("Put back notes.txt.");
    expect(out).toContain("Your message was: make it first");
    expect(await readFile(path.join(h.project, "notes.txt"), "utf8")).toBe("original\n");
  });

  it("asks before overwriting a file changed outside dawg, and cancelling changes nothing", async () => {
    h = await startHarness({ script: TWO_TURNS });
    await writeFile(path.join(h.project, "notes.txt"), "original\n");
    const child = h.spawn(["--endpoint", h.mock.baseUrl, "--permission-mode", "acceptEdits"]);
    const stdin = child.process.stdin;
    if (stdin === null) throw new Error("no stdin");
    stdin.write("make it first\n");
    await child.waitForStdout("Now first.");
    const project = h.project;
    await writeFile(path.join(project, "notes.txt"), "by hand\n");
    stdin.write("/rewind\n");
    await child.waitForStdout("Which point?");
    stdin.write("1\n");
    await child.waitForStdout("What to do?");
    // 3 is "Restore files" here: files and conversation, conversation, files, summarise.
    stdin.write("3\n");
    await child.waitForStdout("Overwrite them");
    stdin.write("n\n");
    await child.waitForStdout("Nothing was changed.");
    stdin.end();
    const result = await child.exited;
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("(changed outside dawg since)");
    expect(await readFile(path.join(project, "notes.txt"), "utf8")).toBe("by hand\n");
  });
});

describe("/memory in interactive mode", () => {
  it("prints the memory folder and instruction files, and makes MEMORY.md", async () => {
    h = await startHarness({ script: [] });
    const child = h.spawn(["--endpoint", h.mock.baseUrl]);
    const stdin = child.process.stdin;
    if (stdin === null) throw new Error("no stdin");
    stdin.write("/memory\n");
    stdin.end();
    const result = await child.exited;
    expect(result.code).toBe(EXIT.ok);
    // The project as the command line resolves it (a temporary folder is behind a link on macOS).
    const key = (await realpath(h.project)).replace(/[^A-Za-z0-9]/g, "-");
    expect(result.stdout).toContain(`Memory for this project: ~/.dawg/projects/${key}/memory`);
    expect(result.stdout).toContain("Instruction files:");
    const index = path.join(h.dawgHome, "projects", key, "memory", "MEMORY.md");
    expect((await stat(index)).isFile()).toBe(true);
    // Not a terminal: nothing is opened, and nothing is asked.
    expect(result.stderr).not.toContain("Set $EDITOR");
  });
});

describe("editorCommand", () => {
  it("takes $VISUAL, then $EDITOR, with its arguments", () => {
    expect(editorCommand({ VISUAL: "code -w", EDITOR: "vi" })).toEqual(["code", "-w"]);
    expect(editorCommand({ EDITOR: " nano " })).toEqual(["nano"]);
    expect(editorCommand({})).toBeNull();
  });
});
