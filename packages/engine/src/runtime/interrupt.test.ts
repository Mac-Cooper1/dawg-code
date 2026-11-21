import { access } from "node:fs/promises";
import path from "node:path";
import { stalled, text, toolCall, toolCalls } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../contracts/index.ts";
import { type Harness, historyProblems, startHarness, textOf } from "./__fixtures__/harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function lastNote(view: readonly Message[]): string {
  const notes = view.filter((m) => m.role === "user" && m.kind === "note");
  return textOf(notes.at(-1));
}

describe("interrupts", () => {
  it("while streaming: keeps the partial text, notes the interruption, and the next prompt works", async () => {
    // The OpenAI flavour sends no progress chunks, so the stall comes right after the first text.
    h = await startHarness({
      mock: { flavor: "openai" },
      script: [
        stalled(text("partial answer that never ends", { pacing: { chunkSize: 8 } }), 2),
        text("fresh"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.prompt(ask("talk"));
    await h.waitFor((e) => e.event === "message.delta");
    expect(session.interrupt()).toBe(true);
    const outcome = await session.waitForIdle();
    expect(outcome?.stopReason).toBe("interrupted");
    const partial = session.view.filter((m) => m.role === "assistant");
    expect(partial).toHaveLength(1);
    expect(textOf(partial[0])).toBe("partial ");
    expect(lastNote(session.view)).toContain('"interrupted"');
    const names = h.names(session.id);
    expect(names.slice(-3)).toEqual(["message.finished", "turn.finished", "session.status"]);
    expect(h.ofType(session.id, "message.finished")[0]?.payload.text).toBe("partial ");
    expect(session.interrupt()).toBe(false);

    const next = await session.run(ask("again"));
    expect(next).toMatchObject({ stopReason: "completed", finalText: "fresh" });
    expect(historyProblems(session.view)).toEqual([]);
  });

  it("while a tool runs: stops the command and gives every call a result", async () => {
    h = await startHarness({
      files: { "a.txt": "a\n" },
      script: [
        toolCalls([
          { name: "Bash", arguments: { command: "echo started; sleep 30 && touch late.txt" } },
          { name: "Read", arguments: { file_path: "a.txt" } },
        ]),
        text("fresh"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "bypassPermissions" });
    await session.prompt(ask("sleep"));
    // Once output arrives the command is surely running (and listening for the interrupt).
    await h.waitFor((e) => e.event === "tool.progress");
    const started = Date.now();
    session.interrupt();
    const outcome = await session.waitForIdle();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome?.stopReason).toBe("interrupted");
    const finished = h
      .ofType(session.id, "tool.finished")
      .map((e) => [e.payload.toolName, e.payload.outcome]);
    expect(finished).toEqual([
      ["Bash", "interrupted"],
      ["Read", "interrupted"],
    ]);
    // The call that never ran still started and finished, in call order.
    expect(h.ofType(session.id, "tool.started").map((e) => e.payload.toolName)).toEqual([
      "Bash",
      "Read",
    ]);
    expect(historyProblems(session.view)).toEqual([]);
    expect(lastNote(session.view)).toContain('"interrupted"');

    const next = await session.run(ask("again"));
    expect(next.stopReason).toBe("completed");
    const exists = await access(path.join(h.project, "late.txt")).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(false);
  });

  it("while waiting on a permission prompt: cancels the request", async () => {
    h = await startHarness({
      script: [toolCall("Write", { file_path: "a.txt", content: "x" }), text("fresh")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.prompt(ask("write"));
    const requested = await h.waitFor((e) => e.event === "permission.requested");
    session.interrupt();
    const outcome = await session.waitForIdle();
    expect(outcome?.stopReason).toBe("interrupted");
    const resolved = h.ofType(session.id, "request.resolved")[0]?.payload;
    expect(resolved).toMatchObject({
      kind: "permission",
      outcome: "cancelled",
      response: null,
      requestId: (requested.payload.request as { requestId: string }).requestId,
    });
    expect(session.snapshot().pending).toEqual([]);
    const requestId = (requested.payload.request as { requestId: string }).requestId;
    expect(() =>
      session.respondPermission(requestId, { behavior: "allow", scope: "once" }),
    ).toThrow(expect.objectContaining({ code: "RequestNotFound" }));
    expect(h.ofType(session.id, "tool.finished")[0]?.payload.outcome).toBe("interrupted");
    expect(historyProblems(session.view)).toEqual([]);
    const next = await session.run(ask("again"));
    expect(next.stopReason).toBe("completed");
  });

  it("close() interrupts a running turn and releases the session", async () => {
    h = await startHarness({
      mock: { flavor: "openai" },
      script: [stalled(text("never ends"), 2)],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.prompt(ask("talk"));
    await h.waitFor((e) => e.event === "message.started");
    await session.close();
    expect(session.closed).toBe(true);
    expect(h.engine.get(session.id)).toBeUndefined();
    await expect(session.prompt(ask("x"))).rejects.toMatchObject({ code: "InvalidState" });
    const reopened = await h.engine.resumeSession(session.id);
    expect(historyProblems(reopened.view)).toEqual([]);
  });
});
