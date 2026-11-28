import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PROTOCOL_VERSION } from "@dawg/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../contracts/index.ts";
import {
  runStep,
  scriptedSteps,
  type TempStore,
  tempStore,
  UNICODE_SAMPLE,
} from "./__fixtures__/script.ts";
import { replay } from "./replay.ts";
import { SessionStore } from "./store.ts";

let t: TempStore;

beforeEach(async () => {
  t = await tempStore();
});
afterEach(async () => {
  await t.cleanup();
});

function expectSameHistory(actual: readonly Message[], expected: readonly Message[]): void {
  expect(actual).toStrictEqual(expected);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

describe("replaying a session file", () => {
  it("rebuilds exactly the in-memory history after every append, across compactions", async () => {
    const writer = await t.store.create({ cwd: t.project });
    const history: Message[] = [];
    const steps = scriptedSteps();
    let compactions = 0;

    for (const step of steps) {
      await runStep(writer, history, step);
      if (step.kind === "compact") compactions += 1;

      const loaded = await t.store.read(t.project, writer.sessionId);
      expectSameHistory(loaded.snapshot.view, history);
      expectSameHistory(writer.snapshot.view, history);
      expect(loaded.snapshot.lastSeq).toBe(writer.lastSeq);
      expect(loaded.snapshot.compactions).toBe(compactions);
      expect(loaded.snapshot.state).toStrictEqual(writer.snapshot.state);
    }
    expect(compactions).toBe(2);

    const final = await t.store.read(t.project, writer.sessionId);
    expect(final.snapshot.state).toStrictEqual({
      mode: "acceptEdits",
      model: null,
      effort: null,
      title: "Fix parser test",
      archived: false,
      tasks: [],
      additionalDirectories: ["/work/shared"],
    });
    // Every record is still in the file: compaction only changes the model's view.
    expect(final.records.length).toBe(steps.length + 1);
    expect(final.records.map((r) => r.seq)).toStrictEqual(final.records.map((_, i) => i));
    await writer.close();
  });

  it("gives the same history after closing and resuming, and keeps appending in sequence", async () => {
    const steps = scriptedSteps();
    const half = Math.floor(steps.length / 2);
    const history: Message[] = [];

    const first = await t.store.create({ cwd: t.project });
    for (const step of steps.slice(0, half)) await runStep(first, history, step);
    const id = first.sessionId;
    const seqBefore = first.lastSeq;
    await first.close();

    const resumed = await t.store.open(t.project, id);
    expectSameHistory(resumed.snapshot.view, history);
    expect(resumed.lastSeq).toBe(seqBefore);
    for (const step of steps.slice(half)) await runStep(resumed, history, step);
    await resumed.close();

    const loaded = await t.store.read(t.project, id);
    expectSameHistory(loaded.snapshot.view, history);
    expect(loaded.snapshot.lastSeq).toBe(steps.length);
  });

  it("writes one JSON object per line with format version, sequence and time", async () => {
    const writer = await t.store.create({ cwd: t.project, title: "first" });
    for (const step of scriptedSteps().slice(0, 6)) await runStep(writer, [], step);
    await writer.close();
    const text = await readFile(writer.file, "utf8");
    const lines = text.split("\n");
    expect(lines.pop()).toBe("");
    for (const [i, line] of lines.entries()) {
      const record = JSON.parse(line);
      expect(record).toMatchObject({ v: 1, seq: i });
      expect(Number.isNaN(Date.parse(record.time))).toBe(false);
    }
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      type: "meta",
      title: "first",
      cwd: t.project,
      forkedFrom: null,
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  it("keeps Unicode and very large records exactly", async () => {
    const writer = await t.store.create({ cwd: t.project });
    const bigText = `${UNICODE_SAMPLE}\n`.repeat(40_000); // about 6 MB
    const bigImage = randomBytes(3 * 1024 * 1024).toString("base64");
    const history: Message[] = [
      { role: "user", kind: "prompt", content: [{ type: "text", text: UNICODE_SAMPLE }] },
      {
        role: "assistant",
        content: UNICODE_SAMPLE,
        reasoning: UNICODE_SAMPLE,
        toolCalls: [
          {
            id: "c1",
            name: "Read",
            arguments: JSON.stringify({ file_path: "/日本/ファイル.txt" }),
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "c1",
        toolName: "Read",
        content: [
          { type: "text", text: bigText },
          { type: "image", mediaType: "image/png", data: bigImage },
        ],
        isError: false,
      },
    ];
    for (const message of history) await writer.appendMessage(message);
    await writer.close();

    const loaded = await t.store.read(t.project, writer.sessionId);
    expectSameHistory(loaded.snapshot.view, history);
    const loadedText = (loaded.snapshot.view[2] as Extract<Message, { role: "tool" }>).content[0];
    expect(loadedText).toStrictEqual({ type: "text", text: bigText });
  });

  it("refuses a message with a field the contract does not define, without touching the file", async () => {
    const writer = await t.store.create({ cwd: t.project });
    const before = await readFile(writer.file, "utf8");
    const bad = { role: "assistant", content: "x", toolCalls: [], extra: 1 } as unknown as Message;
    await expect(writer.appendMessage(bad)).rejects.toMatchObject({ code: "invalid-argument" });
    const wrongType = { role: "user", kind: "prompt", content: "not parts" } as unknown as Message;
    await expect(writer.appendMessage(wrongType)).rejects.toMatchObject({
      code: "invalid-argument",
    });
    expect(await readFile(writer.file, "utf8")).toBe(before);
    // The writer still works after refusing a bad record.
    await writer.appendMessage({ role: "assistant", content: "ok", toolCalls: [] });
    expect(writer.lastSeq).toBe(1);
    await writer.close();
  });

  it.each(["batched", "every-append"] as const)(
    "with %s durability, makes each record readable as soon as its append resolves",
    async (durability) => {
      const store = new SessionStore({ root: t.store.root, durability, flushDelayMs: 5 });
      const writer = await store.create({ cwd: t.project });
      const messages: Message[] = [];
      for (let i = 0; i < 3; i++) {
        const m: Message = { role: "assistant", content: `reply ${i}`, toolCalls: [] };
        await writer.appendMessage(m);
        messages.push(m);
        expect((await store.read(t.project, writer.sessionId)).snapshot.view).toStrictEqual(
          messages,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20)); // Let a batched flush run.
      await writer.appendMessage({ role: "assistant", content: "last", toolCalls: [] });
      await writer.flush();
      await writer.close();
      await expect(writer.flush()).rejects.toMatchObject({ code: "closed" });
      expect((await store.read(t.project, writer.sessionId)).snapshot.lastSeq).toBe(4);
    },
  );

  it("numbers concurrent appends in call order", async () => {
    const writer = await t.store.create({ cwd: t.project });
    const messages: Message[] = Array.from({ length: 50 }, (_, i) => ({
      role: "assistant",
      content: `reply ${i}`,
      toolCalls: [],
    }));
    await Promise.all(messages.map((m) => writer.appendMessage(m)));
    await writer.close();
    const loaded = await t.store.read(t.project, writer.sessionId);
    expectSameHistory(loaded.snapshot.view, messages);
  });

  it("loads a session of ten thousand records quickly", async () => {
    const writer = await t.store.create({ cwd: t.project });
    const history: Message[] = [];
    const startWrite = performance.now();
    for (let i = 0; i < 2500; i++) {
      const id = `call_${i}`;
      const turn: Message[] = [
        {
          role: "user",
          kind: "prompt",
          content: [{ type: "text", text: `Prompt number ${i}: ${"words ".repeat(20)}` }],
        },
        {
          role: "assistant",
          content: `Working on ${i}`,
          reasoning: "thinking ".repeat(30),
          toolCalls: [
            { id, name: "Read", arguments: JSON.stringify({ file_path: `/p/file${i}.ts` }) },
          ],
        },
        {
          role: "tool",
          toolCallId: id,
          toolName: "Read",
          content: [{ type: "text", text: "line\n".repeat(60) }],
          isError: false,
        },
        { role: "assistant", content: `Done with ${i}.`, toolCalls: [] },
      ];
      for (const m of turn) {
        await writer.appendMessage(m);
        history.push(m);
      }
    }
    const writeMs = performance.now() - startWrite;
    await writer.close();

    const startRead = performance.now();
    const loaded = await t.store.read(t.project, writer.sessionId);
    const readMs = performance.now() - startRead;
    expect(loaded.records.length).toBe(10_001);

    const startReplay = performance.now();
    const snapshot = replay(loaded.records);
    const replayMs = performance.now() - startReplay;
    expectSameHistory(snapshot.view, history);

    const size = (await readFile(writer.file)).length;
    console.info(
      `10,000 records, ${(size / 1024 / 1024).toFixed(1)} MB: write ${writeMs.toFixed(0)} ms (sync off), ` +
        `read+validate+replay ${readMs.toFixed(0)} ms, replay alone ${replayMs.toFixed(1)} ms`,
    );
    expect(readMs).toBeLessThan(3000);
  });
});
