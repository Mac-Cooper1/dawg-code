import { appendFile, readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../contracts/index.ts";
import { type TempStore, tempStore } from "./__fixtures__/script.ts";

let t: TempStore;

beforeEach(async () => {
  t = await tempStore();
});
afterEach(async () => {
  await t.cleanup();
});

const reply = (text: string): Message => ({ role: "assistant", content: text, toolCalls: [] });

async function sessionWith(
  count: number,
): Promise<{ id: string; file: string; messages: Message[] }> {
  const writer = await t.store.create({ cwd: t.project });
  const messages = Array.from({ length: count }, (_, i) => reply(`reply ${i}`));
  for (const m of messages) await writer.appendMessage(m);
  await writer.close();
  return { id: writer.sessionId, file: writer.file, messages };
}

describe("a torn last line", () => {
  it("is ignored on read and cut off before the next append", async () => {
    const { id, file, messages } = await sessionWith(3);
    const intact = await readFile(file, "utf8");
    await appendFile(file, '{"type":"assistant","v":1,"seq":4,"time":"2026-11-21T0');

    const loaded = await t.store.read(t.project, id);
    expect(loaded.tornTail).toBe(true);
    expect(loaded.snapshot.view).toStrictEqual(messages);
    expect(loaded.snapshot.lastSeq).toBe(3);
    // Reading never modifies the file: a reader may be looking while a writer is mid-append.
    expect(await readFile(file, "utf8")).not.toBe(intact);

    const writer = await t.store.open(t.project, id);
    expect(await readFile(file, "utf8")).toBe(intact);
    await writer.appendMessage(reply("after repair"));
    await writer.close();

    const after = await t.store.read(t.project, id);
    expect(after.tornTail).toBe(false);
    expect(after.snapshot.view).toStrictEqual([...messages, reply("after repair")]);
    expect(after.snapshot.lastSeq).toBe(4);
  });

  it("is ignored even when it holds a complete object, because its newline was never written", async () => {
    const { id, file, messages } = await sessionWith(1);
    await appendFile(
      file,
      JSON.stringify({
        type: "assistant",
        v: 1,
        seq: 2,
        time: new Date().toISOString(),
        message: reply("x"),
      }),
    );
    const loaded = await t.store.read(t.project, id);
    expect(loaded.tornTail).toBe(true);
    expect(loaded.snapshot.view).toStrictEqual(messages);
  });
});

describe("a damaged middle line", () => {
  async function damage(file: string, lineIndex: number, replacement: string): Promise<void> {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines[lineIndex] = replacement;
    await writeFile(file, lines.join("\n"));
  }

  it("fails loudly by default, naming the line", async () => {
    const { id, file } = await sessionWith(4);
    await damage(file, 2, "{not json");
    const error = await t.store.read(t.project, id).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "corrupt", line: 3, file });
    expect((error as Error).message).toContain("line 3");
    await expect(t.store.open(t.project, id)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("can be skipped and reported, for salvage", async () => {
    const { id, file, messages } = await sessionWith(4);
    await damage(file, 2, '{"type":"assistant","v":1,"seq":2,"time":"x","message":{}}');
    const loaded = await t.store.read(t.project, id, { onCorrupt: "skip" });
    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0]?.line).toBe(3);
    expect(loaded.snapshot.view).toStrictEqual([messages[0], messages[2], messages[3]]);
  });

  it("includes a sequence number that does not follow the previous one", async () => {
    const { id, file } = await sessionWith(3);
    const lines = (await readFile(file, "utf8")).split("\n");
    const record = JSON.parse(lines[2] as string);
    record.seq = 7;
    lines[2] = JSON.stringify(record);
    await writeFile(file, lines.join("\n"));
    await expect(t.store.read(t.project, id)).rejects.toMatchObject({ code: "corrupt", line: 3 });
  });

  it("includes a record from a newer format, which is never skipped", async () => {
    const { id, file } = await sessionWith(2);
    const lines = (await readFile(file, "utf8")).split("\n");
    const record = JSON.parse(lines[1] as string);
    record.v = 2;
    lines[1] = JSON.stringify(record);
    await writeFile(file, lines.join("\n"));
    await expect(t.store.read(t.project, id, { onCorrupt: "skip" })).rejects.toMatchObject({
      code: "unsupported-version",
    });
  });

  it("shows the session as damaged in the listing instead of breaking it", async () => {
    const good = await sessionWith(1);
    const bad = await sessionWith(2);
    await damage(bad.file, 1, "garbage");
    const list = await t.store.list(t.project);
    expect(list.map((s) => s.id).sort()).toStrictEqual([good.id, bad.id].sort());
    expect(list.find((s) => s.id === bad.id)?.damaged).toContain("line 2");
    expect(list.find((s) => s.id === good.id)?.damaged).toBeNull();
  });
});

describe("an empty file", () => {
  it("is reported as empty, and listed as damaged", async () => {
    const { id, file } = await sessionWith(0);
    await writeFile(file, "");
    await expect(t.store.read(t.project, id)).rejects.toMatchObject({ code: "empty" });
    await expect(t.store.open(t.project, id)).rejects.toMatchObject({ code: "empty" });
    const [entry] = await t.store.list(t.project);
    expect(entry?.damaged).toContain("no complete record");
  });

  it("holding only a torn line is empty too", async () => {
    const { id, file } = await sessionWith(0);
    await writeFile(file, '{"type":"meta"');
    await expect(t.store.read(t.project, id)).rejects.toMatchObject({ code: "empty" });
  });
});

describe("a missing session", () => {
  it("is not-found for read, open and delete", async () => {
    await expect(t.store.read(t.project, "nope")).rejects.toMatchObject({ code: "not-found" });
    await expect(t.store.open(t.project, "nope")).rejects.toMatchObject({ code: "not-found" });
    await expect(t.store.delete(t.project, "nope")).rejects.toMatchObject({ code: "not-found" });
  });

  it("refuses ids that could leave the sessions folder", async () => {
    await expect(t.store.read(t.project, "../escape")).rejects.toMatchObject({
      code: "invalid-argument",
    });
  });
});
