import { readFile } from "node:fs/promises";
import path from "node:path";
import { type ScriptReply, stalled, text, toolCall } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./__fixtures__/harness.ts";
import { EXIT } from "./exit-codes.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

/** Interactive sessions name themselves after the first turn; titles get their own lane. */
function withTitles(replies: ScriptReply[]) {
  return {
    replies,
    lanes: { title: { match: { hasTools: false }, replies: [text("A title"), text("A title")] } },
  };
}

describe("interactive mode through pipes", () => {
  it("streams a reply, asks permission, shows the diff and runs slash commands", async () => {
    h = await startHarness({
      script: withTitles([
        text("Hello there."),
        toolCall("Write", { file_path: "hello.txt", content: "hi\nthere\n" }),
        text("Wrote it."),
      ]),
    });
    const child = h.spawn(["--endpoint", h.mock.baseUrl]);
    const stdin = child.process.stdin;
    if (stdin === null) throw new Error("no stdin");
    stdin.write("hello\n");
    await child.waitForStdout("Hello there.");
    // The answer to the permission prompt is simply the next line.
    stdin.write("please write hello.txt\n");
    await child.waitForStdout("Allow?");
    stdin.write("y\n");
    await child.waitForStdout("Wrote it.");
    stdin.write("/mode acceptEdits\n");
    stdin.write("/nonsense\n");
    stdin.write("/status\n");
    stdin.end();
    const result = await child.exited;
    expect(result.code).toBe(EXIT.ok);
    const out = result.stdout;
    expect(out).toContain("Hello there.\n");
    expect(out).toContain("Permission needed: ");
    expect(out).toContain("* Write hello.txt: done (+2 -0)");
    expect(out).toContain("+there");
    expect(out).toContain("Mode: acceptEdits.");
    expect(out).toContain("Endpoint: remote at http://127.0.0.1:");
    expect(result.stderr).toContain("Unknown command /nonsense");
    expect(await readFile(path.join(h.project, "hello.txt"), "utf8")).toBe("hi\nthere\n");
    // Only the two prompts reached the model; the commands did not.
    expect(h.mock.chatRequests.filter((r) => r.lane === "main")).toHaveLength(3);
    // Nothing that looks like terminal control codes when output is not a terminal.
    expect(out).not.toContain("\u001b[");
  });

  it("denies with a reason, and treats the end of input as no answer", async () => {
    h = await startHarness({
      script: withTitles([
        toolCall("Write", { file_path: "a.txt", content: "a" }),
        text("ok, not writing"),
        toolCall("Write", { file_path: "b.txt", content: "b" }),
        text("still not"),
      ]),
    });
    const child = h.spawn(["--endpoint", h.mock.baseUrl]);
    const stdin = child.process.stdin;
    if (stdin === null) throw new Error("no stdin");
    stdin.write("write a\nn not today\nwrite b\n");
    stdin.end();
    const result = await child.exited;
    expect(result.code).toBe(EXIT.ok);
    const main = h.mock.chatRequests.filter((r) => r.lane === "main");
    expect(JSON.stringify(main[1]?.body)).toContain("not today");
    expect(JSON.stringify(main[3]?.body)).toContain("input ended");
    expect(result.stdout).toContain("still not");
  });

  it("says which mode approving a plan leads to", async () => {
    h = await startHarness({
      script: withTitles([
        toolCall("EnterPlanMode", {}),
        toolCall("ExitPlanMode", { plan: "1. Write a.txt" }),
        text("Planned and done."),
      ]),
    });
    const child = h.spawn(["--endpoint", h.mock.baseUrl, "--permission-mode", "acceptEdits"]);
    const stdin = child.process.stdin;
    if (stdin === null) throw new Error("no stdin");
    stdin.write("plan it\n");
    await child.waitForStdout("Approve? y = yes (then acceptEdits mode)");
    stdin.write("y\n");
    await child.waitForStdout("Planned and done.");
    stdin.end();
    const result = await child.exited;
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("Proposed plan:");
  });

  it("stops waiting for an answer when the turn is interrupted", async () => {
    h = await startHarness({
      script: withTitles([toolCall("Write", { file_path: "a.txt", content: "a" }), text("again")]),
    });
    const child = h.spawn(["--endpoint", h.mock.baseUrl]);
    const stdin = child.process.stdin;
    if (stdin === null) throw new Error("no stdin");
    stdin.write("write a\n");
    await child.waitForStdout("Allow?");
    child.process.kill("SIGINT");
    await child.waitForStdout("(the request was closed)");
    // The next line is a prompt again, not a late answer.
    stdin.write("hello again\n");
    await child.waitForStdout("again\n");
    stdin.end();
    const result = await child.exited;
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("(interrupted)");
    expect(result.stdout).toContain("* Write a.txt: interrupted");
  });

  it("asks again for a permission the session was waiting for when it stopped", async () => {
    h = await startHarness({
      script: withTitles([
        toolCall("Write", { file_path: "a.txt", content: "a\n" }),
        text("Wrote a."),
      ]),
    });
    const first = h.spawn(["--endpoint", h.mock.baseUrl]);
    first.process.stdin?.write("write a\n");
    await first.waitForStdout("Allow?");
    const sessionId = /session (\S+),/.exec(first.stderr())?.[1];
    if (sessionId === undefined) throw new Error(`no session id in: ${first.stderr()}`);
    // Gone without answering, as when the terminal is closed.
    first.process.kill("SIGKILL");
    await first.exited;

    const second = h.spawn(["--endpoint", h.mock.baseUrl, "--resume", sessionId]);
    const stdin = second.process.stdin;
    if (stdin === null) throw new Error("no stdin");
    await second.waitForStdout("Allow?");
    stdin.write("y\n");
    await second.waitForStdout("Wrote a.");
    stdin.end();
    const result = await second.exited;
    expect(result.code).toBe(EXIT.ok);
    expect(await readFile(path.join(h.project, "a.txt"), "utf8")).toBe("a\n");
  });

  it("interrupts a turn on the first SIGINT and quits on the next", async () => {
    h = await startHarness({ script: withTitles([stalled(text("never ends"))]) });
    const child = h.spawn(["--endpoint", h.mock.baseUrl]);
    child.process.stdin?.write("wait forever\n");
    for (let i = 0; i < 500 && h.mock.chatRequests.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    child.process.kill("SIGINT");
    await child.waitForStdout("(interrupted)");
    // At the prompt, Ctrl+C quits like the end of input does.
    child.process.kill("SIGINT");
    const result = await child.exited;
    expect(result.code).toBe(EXIT.ok);
  });
});
