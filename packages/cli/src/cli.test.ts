import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { httpError, stalled, text, toolCall } from "@dawg/mock-model";
import {
  createClient,
  createNdjsonTransport,
  type EngineEvent,
  type Transport,
} from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, jsonLines, startHarness } from "./__fixtures__/harness.ts";
import { EXIT } from "./exit-codes.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const endpointArgs = () => ["--endpoint", (h as Harness).mock.baseUrl];

function lastUserText(h: Harness, request = -1): string {
  const messages = h.mock.messages(request) as { role: string; content: unknown }[];
  const user = messages.filter((m) => m.role === "user").at(-1);
  return JSON.stringify(user?.content ?? "");
}

describe("usage", () => {
  it("prints help and the version, and refuses bad usage with exit 2", async () => {
    h = await startHarness();
    const help = await h.run(["--help"]);
    expect(help.code).toBe(EXIT.ok);
    expect(help.stdout).toContain("--output-format <format>");
    expect(help.stdout).toContain("Exit codes:");
    const version = await h.run(["-v"]);
    expect(version.stdout).toMatch(/^dawg \d+\.\d+\.\d+\n$/);

    const unknown = await h.run(["-p", "hi", "--frobnicate"]);
    expect(unknown.code).toBe(EXIT.usage);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain("Unknown option --frobnicate");

    const noModel = await h.run(["-p", "hi"]);
    expect(noModel.code).toBe(EXIT.usage);
    expect(noModel.stderr).toContain("--endpoint");
    expect(noModel.stdout).toBe("");

    const noPrompt = await h.run(["-p", ...endpointArgs()]);
    expect(noPrompt.code).toBe(EXIT.usage);
    expect(noPrompt.stderr).toContain("No prompt");
  });
});

describe("output formats", () => {
  it("text prints the final message and nothing else", async () => {
    h = await startHarness({ script: [text("All done.")] });
    const result = await h.run(["-p", "say done", ...endpointArgs()]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toBe("All done.\n");
    expect(lastUserText(h)).toContain("say done");
  });

  it("json prints one object with the result, stop reason, usage, ids, requests and duration", async () => {
    h = await startHarness({
      script: [toolCall("Read", { file_path: "notes.txt" }), text("It says hello.")],
    });
    await writeFile(path.join(h.project, "notes.txt"), "hello\n");
    const result = await h.run(["-p", "read notes", "--output-format", "json", ...endpointArgs()]);
    expect(result.code).toBe(EXIT.ok);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0] as string);
    expect(out).toMatchObject({
      type: "result",
      result: "It says hello.",
      stopReason: "completed",
      isError: false,
      error: null,
      numRequests: 2,
    });
    expect(out.sessionId).toMatch(/\S/);
    expect(out.turnId).toMatch(/^turn-/);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    expect(out.usage.totals.requests).toBe(2);
  });

  it("stream-json prints every protocol event as one line, and nothing else", async () => {
    h = await startHarness({ script: [text(["Hel", "lo"])] });
    const result = await h.run([
      "-p",
      "greet",
      "--output-format",
      "stream-json",
      ...endpointArgs(),
    ]);
    expect(result.code).toBe(EXIT.ok);
    const events = jsonLines(result.stdout);
    const names = events.map((e) => e.event);
    expect(names).toEqual(
      expect.arrayContaining([
        "session.status",
        "turn.started",
        "message.started",
        "message.delta",
        "message.finished",
        "usage.updated",
        "turn.finished",
      ]),
    );
    const seqs = events.map((e) => e.payload.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(events.map((e) => e.payload.sessionId)).size).toBe(1);
    expect(events.find((e) => e.event === "turn.finished")?.payload).toMatchObject({
      stopReason: "completed",
      finalText: "Hello",
    });
  });
});

describe("exit codes", () => {
  it("exits 1 when the model fails or the endpoint is unreachable", async () => {
    h = await startHarness({ script: [httpError(400, "bad request")] });
    const failed = await h.run(["-p", "x", ...endpointArgs()]);
    expect(failed.code).toBe(EXIT.error);
    expect(failed.stderr).toContain("Error:");
    expect(failed.stdout).toBe("");
    const unreachable = await h.run(["-p", "x", "--endpoint", "http://127.0.0.1:9/v1"]);
    expect(unreachable.code).toBe(EXIT.error);
    expect(unreachable.stderr).toContain("Could not list the models");
  });

  it("exits 3 at the turn limit", async () => {
    h = await startHarness({
      script: [toolCall("Glob", { pattern: "*.txt" }), toolCall("Glob", { pattern: "*.md" })],
    });
    const result = await h.run([
      "-p",
      "look",
      "--max-turns",
      "1",
      "--output-format",
      "json",
      ...endpointArgs(),
    ]);
    expect(result.code).toBe(EXIT.turnLimit);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: "turn_limit", isError: true });
    expect(h.mock.chatRequests).toHaveLength(1);
    expect(result.stderr).toContain("limit of 1");
  });

  it("interrupts cleanly on SIGINT and exits 130", async () => {
    h = await startHarness({ script: [stalled(text("never ends"))] });
    const child = h.spawn(["-p", "wait", "--output-format", "stream-json", ...endpointArgs()]);
    child.process.stdin?.end();
    await child.waitForStdout('"turn.started"');
    child.process.kill("SIGINT");
    const result = await child.exited;
    expect(result.code).toBe(EXIT.interrupted);
    const events = jsonLines(result.stdout);
    expect(events.at(-1)?.event).toBe("session.status");
    expect(events.find((e) => e.event === "turn.finished")?.payload).toMatchObject({
      stopReason: "interrupted",
    });
  });
});

describe("termination", () => {
  it("stops the turn cleanly on SIGTERM and exits 143", async () => {
    h = await startHarness({ script: [stalled(text("never ends"))] });
    const child = h.spawn(["-p", "wait", "--output-format", "json", ...endpointArgs()]);
    child.process.stdin?.end();
    for (let i = 0; i < 500 && h.mock.chatRequests.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    child.process.kill("SIGTERM");
    const result = await child.exited;
    expect(result.code).toBe(EXIT.terminated);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: "interrupted", isError: true });
  });
});

describe("unattended permissions", () => {
  const writeScript = () => [
    toolCall("Write", { file_path: "out.txt", content: "written\n" }),
    text("finished"),
  ];

  it("denies what would need an answer, unless a rule or the mode allows it", async () => {
    h = await startHarness({ script: [...writeScript(), ...writeScript(), ...writeScript()] });
    const denied = await h.run([
      "-p",
      "write",
      "--output-format",
      "stream-json",
      ...endpointArgs(),
    ]);
    expect(denied.code).toBe(EXIT.ok);
    const finished = jsonLines(denied.stdout).find((e) => e.event === "tool.finished");
    expect(finished?.payload).toMatchObject({ toolName: "Write", outcome: "denied" });
    expect(jsonLines(denied.stdout).some((e) => e.event === "permission.requested")).toBe(false);
    await expect(readFile(path.join(h.project, "out.txt"), "utf8")).rejects.toThrow();

    const allowed = await h.run(["-p", "write", "--allowedTools", "Write", ...endpointArgs()]);
    expect(allowed.code).toBe(EXIT.ok);
    expect(await readFile(path.join(h.project, "out.txt"), "utf8")).toBe("written\n");

    await writeFile(path.join(h.project, "out.txt"), "old\n");
    const byMode = await h.run([
      "-p",
      "write",
      "--permission-mode",
      "acceptEdits",
      ...endpointArgs(),
    ]);
    expect(byMode.code).toBe(EXIT.ok);
    // Overwriting needs a prior Read: the tool refuses, whatever the permission.
    expect(await readFile(path.join(h.project, "out.txt"), "utf8")).toBe("old\n");
  });

  it("lets deny rules win over bypass, and refuses bypass when settings forbid it", async () => {
    h = await startHarness({
      script: [toolCall("Write", { file_path: "secret.txt", content: "x" }), text("ok")],
    });
    const result = await h.run([
      "-p",
      "write",
      "--dangerously-skip-permissions",
      "--disallowedTools",
      "Write",
      "--output-format",
      "stream-json",
      ...endpointArgs(),
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(
      jsonLines(result.stdout).find((e) => e.event === "tool.finished")?.payload,
    ).toMatchObject({
      outcome: "denied",
    });

    await mkdir(h.dawgHome, { recursive: true });
    await writeFile(
      path.join(h.dawgHome, "settings.json"),
      JSON.stringify({ permissions: { disableBypassPermissionsMode: "disable" } }),
    );
    const refused = await h.run([
      "-p",
      "x",
      "--permission-mode",
      "bypassPermissions",
      ...endpointArgs(),
    ]);
    expect(refused.code).toBe(EXIT.usage);
    expect(refused.stderr).toContain("bypassPermissions");
  });

  it("gives questions and plans the nobody-can-answer result", async () => {
    h = await startHarness({
      script: [
        toolCall("AskUserQuestion", {
          questions: [
            {
              question: "Which?",
              header: "Pick",
              options: [{ label: "A" }, { label: "B" }],
              multiSelect: false,
            },
          ],
        }),
        text("chose myself"),
      ],
    });
    const result = await h.run([
      "-p",
      "ask me",
      "--output-format",
      "stream-json",
      ...endpointArgs(),
    ]);
    expect(result.code).toBe(EXIT.ok);
    const events = jsonLines(result.stdout);
    expect(events.some((e) => e.event === "question.asked")).toBe(false);
    expect(JSON.stringify(h.mock.messages(-1))).toMatch(/no one|nobody/i);
  });
});

describe("sessions and input", () => {
  it("continues the latest session here, resumes by id from anywhere, and reads stdin", async () => {
    h = await startHarness({ script: [text("first"), text("second"), text("third")] });
    const one = await h.run(["-p", "--output-format", "json", ...endpointArgs()], {
      stdin: "remember the word heron\n",
    });
    expect(one.code).toBe(EXIT.ok);
    const sessionId = JSON.parse(one.stdout).sessionId as string;
    expect(lastUserText(h)).toContain("heron");

    const two = await h.run([
      "-p",
      "what word?",
      "-c",
      "--output-format",
      "json",
      ...endpointArgs(),
    ]);
    expect(JSON.parse(two.stdout).sessionId).toBe(sessionId);
    expect(JSON.stringify(h.mock.messages(-1))).toContain("heron");

    const elsewhere = path.join(h.root, "elsewhere");
    await mkdir(elsewhere);
    const three = await h.run(
      ["-p", "again", "--resume", sessionId, "--output-format", "json", ...endpointArgs()],
      { cwd: elsewhere },
    );
    expect(three.code).toBe(EXIT.ok);
    expect(JSON.parse(three.stdout)).toMatchObject({ sessionId, result: "third" });

    const missing = await h.run(["-p", "x", "--resume", "nope", ...endpointArgs()]);
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.stderr).toContain("nope");
  });

  it("runs a known slash command given as the prompt", async () => {
    h = await startHarness();
    const result = await h.run(["-p", "/status", ...endpointArgs()]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("Endpoint: remote at http://127.0.0.1:");
    expect(h.mock.chatRequests).toHaveLength(0);
  });
});

describe("the API key", () => {
  it("is read from DAWG_API_KEY, used, and appears in no output and no file", async () => {
    const key = "sk-test-0123456789-SECRET";
    h = await startHarness({
      mock: { apiKey: key },
      script: [
        toolCall("Bash", { command: "printenv DAWG_API_KEY || echo key=unset" }),
        text("done"),
      ],
    });
    const withKey = await h.run(
      [
        "-p",
        "go",
        "--output-format",
        "stream-json",
        "--verbose",
        "--allowedTools",
        "Bash",
        ...endpointArgs(),
      ],
      { env: { DAWG_API_KEY: key } },
    );
    expect(withKey.code).toBe(EXIT.ok);
    const without = await h.run(["-p", "go", ...endpointArgs()]);
    expect(without.code).toBe(EXIT.error);
    expect(without.stderr).toContain("DAWG_API_KEY");
    for (const output of [withKey.stdout, withKey.stderr, without.stdout, without.stderr]) {
      expect(output).not.toContain(key);
    }
    const files = await h.allFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(file.content.toString("utf8")).not.toContain(key);
    // The command the agent ran did not inherit the key either.
    const sent = JSON.stringify(h.mock.messages(1));
    expect(sent).toContain("key=unset");
    expect(sent).not.toContain(key);
  });
});

describe("dawg serve", () => {
  it("serves the protocol on stdio to a client, and exits when its input ends", async () => {
    h = await startHarness({ script: [text("served")] });
    const child = h.spawn(["serve", ...endpointArgs()]);
    const problems: string[] = [];
    const stdin = child.process.stdin;
    const stdout = child.process.stdout;
    if (stdin === null || stdout === null) throw new Error("no pipes");
    const transport: Transport = createNdjsonTransport({ input: stdout, output: stdin });
    const client = createClient(transport, {
      timeoutMs: 15_000,
      onProblem: (p) => problems.push(`${p.kind}: ${p.message}`),
    });
    transport.onError((e) => problems.push(`transport: ${e.message}`));
    const events: EngineEvent[] = [];
    client.onEvent((e) => events.push(e));
    const init = await client.initialize({
      client: { name: "test", version: "1" },
      capabilities: {},
    });
    expect(init.engine.name).toBe("dawg");
    const snap = await client.request("session.create", { cwd: h.project });
    expect(snap.modelInfo?.id).toBe("mock-model");
    const { turnId } = await client.request("session.prompt", {
      sessionId: snap.session.id,
      prompt: { content: [{ type: "text", text: "hello" }] },
    });
    for (let i = 0; i < 500 && !events.some((e) => e.event === "turn.finished"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(events.find((e) => e.event === "turn.finished")?.payload).toMatchObject({
      turnId,
      finalText: "served",
    });
    client.close();
    const result = await child.exited;
    expect(result.code).toBe(EXIT.ok);
    expect(problems).toEqual([]);
  });
});
