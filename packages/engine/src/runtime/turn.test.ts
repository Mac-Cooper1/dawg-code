import { readFile } from "node:fs/promises";
import path from "node:path";
import { text, toolCall } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import { type ModelClient, ModelError } from "../contracts/model.ts";
import { createModelClient } from "../model/index.ts";
import { type Harness, historyProblems, startHarness, textOf } from "./__fixtures__/harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe("a whole turn", () => {
  it("reads, edits, runs a command and answers, emitting the documented events in order", async () => {
    h = await startHarness({
      files: {
        "notes.txt": "hello world\n",
        ".dawg/settings.json": JSON.stringify({ permissions: { allow: ["Bash(touch *)"] } }),
      },
      script: [
        toolCall("Read", { file_path: "notes.txt" }, { text: "Let me look." }),
        toolCall("Edit", { file_path: "notes.txt", old_string: "hello", new_string: "goodbye" }),
        toolCall("Bash", { command: "touch marker.txt && cat notes.txt", description: "Show it" }),
        text("The file now says goodbye world."),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "acceptEdits" });
    const outcome = await session.run({
      content: [{ type: "text", text: "Change hello to goodbye" }],
    });

    expect(outcome.stopReason).toBe("completed");
    expect(outcome.finalText).toBe("The file now says goodbye world.");
    expect(outcome.error).toBeNull();
    expect(await readFile(path.join(h.project, "notes.txt"), "utf8")).toBe("goodbye world\n");

    const reply = ["message.started", "message.finished", "usage.updated"];
    const call = [...reply, "tool.started", "tool.finished"];
    expect(h.names(session.id)).toEqual([
      "session.status",
      "turn.started",
      ...call,
      ...call,
      ...call,
      ...reply,
      "turn.finished",
      "session.status",
    ]);
    expect(h.problems).toEqual([]);

    const finished = h.ofType(session.id, "tool.finished").map((e) => e.payload);
    expect(finished.map((p) => [p.toolName, p.outcome])).toEqual([
      ["Read", "success"],
      ["Edit", "success"],
      ["Bash", "success"],
    ]);
    expect((finished[0]?.display as { kind: string } | undefined)?.kind).toBe("file");
    expect((finished[1]?.display as { kind: string } | undefined)?.kind).toBe("diff");
    expect((finished[2]?.display as { exitCode: number } | undefined)?.exitCode).toBe(0);
    expect(
      textOf({
        role: "tool",
        toolCallId: "",
        toolName: "",
        isError: false,
        content: finished[2]?.content as [],
      }),
    ).toContain("goodbye world");

    const statuses = h.ofType(session.id, "session.status").map((e) => e.payload.status);
    expect(statuses).toEqual(["working", "idle"]);
    const turnStarted = h.ofType(session.id, "turn.started")[0]?.payload;
    expect(turnStarted?.turnId).toBe(outcome.turnId);
    expect(h.ofType(session.id, "turn.finished")[0]?.payload).toMatchObject({
      turnId: outcome.turnId,
      stopReason: "completed",
      finalText: "The file now says goodbye world.",
    });
    // The streamed text and the finished message agree.
    const firstMessage = h.ofType(session.id, "message.finished")[0]?.payload;
    const deltas = h
      .ofType(session.id, "message.delta")
      .filter((e) => e.payload.messageId === firstMessage?.messageId)
      .map((e) => e.payload.text)
      .join("");
    expect(deltas).toBe("Let me look.");

    // Four requests, each ending with what the previous step produced.
    expect(h.mock.chatRequests).toHaveLength(4);
    const last = h.mock.messages(3) as { role: string }[];
    expect(last.at(-1)?.role).toBe("tool");
    expect(historyProblems(session.view)).toEqual([]);
    expect(session.snapshot().usage?.totals.requests).toBe(4);
    h.mock.assertDone();
  });

  it("rejects a second prompt while a turn runs", async () => {
    h = await startHarness({
      script: [{ text: "slow", pacing: { firstEventDelayMs: 200 } }],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.prompt({ content: [{ type: "text", text: "one" }] });
    await expect(
      session.prompt({ content: [{ type: "text", text: "two" }] }),
    ).rejects.toMatchObject({
      code: "SessionBusy",
    });
    const outcome = await session.waitForIdle();
    expect(outcome?.stopReason).toBe("completed");
  });

  it("includes mentioned files with the prompt", async () => {
    h = await startHarness({ files: { "a.txt": "line one\nline two\n" }, script: [text("ok")] });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run({
      content: [{ type: "text", text: "Look at this" }],
      mentions: [{ path: "a.txt", startLine: 2, endLine: 2 }],
    });
    const prompt = session.view.find((m) => m.role === "user" && m.kind === "prompt");
    expect(textOf(prompt)).toContain("line two");
    expect(textOf(prompt)).not.toContain("line one");
    const started = h.ofType(session.id, "turn.started")[0]?.payload as unknown as {
      prompt: { mentions: unknown[] };
    };
    expect(started.prompt.mentions).toEqual([{ path: "a.txt", startLine: 2, endLine: 2 }]);
  });

  it("generates a title after the first turn on the side slot, without touching history", async () => {
    h = await startHarness({
      slots: { main: 0, utility: 1 },
      engine: { generateTitles: true },
      script: {
        replies: [text("Done.")],
        lanes: {
          title: { match: { system: "short title" }, replies: [text('"Fix the parser."')] },
        },
      },
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run({ content: [{ type: "text", text: "Fix the parser" }] });
    const updated = await h.waitFor(
      (e) => e.event === "session.updated" && (e.payload.changed as string[]).includes("title"),
    );
    expect(updated.payload.title).toBe("Fix the parser");
    expect(session.summary().title).toBe("Fix the parser");
    const titleRequest = h.mock.chatRequests.find((r) => r.lane === "title");
    const mainRequest = h.mock.chatRequests.find((r) => r.lane !== "title");
    expect((titleRequest?.body as { id_slot?: number } | undefined)?.id_slot).toBe(1);
    expect((mainRequest?.body as { id_slot?: number } | undefined)?.id_slot).toBe(0);
    expect((titleRequest?.body as { tools?: unknown[] } | undefined)?.tools ?? []).toEqual([]);
    expect(session.view.some((m) => textOf(m).includes("Fix the parser."))).toBe(false);
    h.mock.assertDone();
  });

  it("shows a provider's 'unavailable' message as it is, and retries it once when retryable", async () => {
    const refusal = "No model is installed yet. Download one in Settings → Models.";
    const failures: ModelError[] = [];
    let attempts = 0;
    h = await startHarness({ script: [text("Back again.")] });
    const real = createModelClient(h.mock.endpoint);
    const client: ModelClient = {
      endpoint: real.endpoint,
      async *stream(request) {
        attempts += 1;
        const failure = failures.shift();
        if (failure !== undefined) throw failure;
        yield* real.stream(request);
      },
      countTokens: (request) => real.countTokens(request),
    };
    const engine = h.newEngine({ models: { connect: async () => ({ client }) } });
    const session = await engine.createSession({ cwd: h.project });

    // Not retryable: the turn ends at once, in the provider's words.
    failures.push(new ModelError("unavailable", refusal));
    const failed = await session.run({ content: [{ type: "text", text: "Hi" }] });
    expect(failed.stopReason).toBe("error");
    expect(failed.error).toEqual({
      kind: "model_unavailable",
      message: refusal,
      detail: null,
      retryable: false,
    });
    expect(attempts).toBe(1);
    const shown = h.ofType(session.id, "turn.finished").at(-1)?.payload.error;
    expect(shown).toMatchObject({ kind: "model_unavailable", message: refusal });

    // Retryable: sent once more, which works.
    attempts = 0;
    failures.push(new ModelError("unavailable", "The runtime is restarting.", { retryable: true }));
    const recovered = await session.run({ content: [{ type: "text", text: "Again" }] });
    expect(recovered.error).toBeNull();
    expect(recovered.finalText).toBe("Back again.");
    expect(attempts).toBe(2);
  });
});
