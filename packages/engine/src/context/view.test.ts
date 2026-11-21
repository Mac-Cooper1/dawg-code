import { describe, expect, test } from "vitest";
import type { Message } from "../contracts/messages.ts";
import { checkView, normalizePairs, splitSteps, splitTurns } from "./view.ts";

const prompt = (text: string): Message => ({
  role: "user",
  kind: "prompt",
  content: [{ type: "text", text }],
});
const note = (text: string): Message => ({
  role: "user",
  kind: "note",
  content: [{ type: "text", text }],
});
const call = (...ids: string[]): Message => ({
  role: "assistant",
  content: "",
  toolCalls: ids.map((id) => ({ id, name: "Read", arguments: "{}" })),
});
const result = (id: string): Message => ({
  role: "tool",
  toolCallId: id,
  toolName: "Read",
  content: [{ type: "text", text: `result ${id}` }],
  isError: false,
});
const reply = (text: string): Message => ({ role: "assistant", content: text, toolCalls: [] });

describe("checkView", () => {
  test("accepts a well-formed view", () => {
    expect(
      checkView([
        note("ctx"),
        prompt("go"),
        call("a", "b"),
        result("b"),
        result("a"),
        note("file changed"),
        reply("done"),
      ]),
    ).toEqual([]);
  });

  test("finds every kind of problem", () => {
    expect(checkView([reply("hi")])[0]).toMatch(/start with a user message/);
    expect(checkView([prompt("x"), { role: "system", content: "s" }])[0]).toMatch(/system/);
    expect(checkView([prompt("x"), result("a")])[0]).toMatch(/no call before it/);
    expect(checkView([prompt("x"), call("a")])[0]).toMatch(/a of message 1 has no result/);
    expect(checkView([prompt("x"), call("a"), note("n"), result("a")]).length).toBe(2);
    expect(checkView([prompt("x"), call("a"), result("b")]).length).toBe(2);
    expect(checkView([prompt("x"), call("a", "a"), result("a")])[0]).toMatch(/same id/);
  });
});

describe("turns and steps", () => {
  const history = [
    note("ctx"),
    prompt("one"),
    call("a"),
    result("a"),
    reply("ok"),
    prompt("two"),
    note("n"),
    call("b"),
    result("b"),
    call("c"),
    result("c"),
  ];

  test("a turn starts at each prompt", () => {
    expect(splitTurns(history)).toEqual([
      { start: 1, end: 5 },
      { start: 5, end: 11 },
    ]);
  });

  test("a step starts at each assistant message", () => {
    expect(splitSteps(history, { start: 5, end: 11 })).toEqual([
      { start: 7, end: 9 },
      { start: 9, end: 11 },
    ]);
  });
});

describe("normalizePairs", () => {
  test("leaves a valid run unchanged", () => {
    const run = [prompt("x"), call("a"), result("a"), note("n"), reply("y")];
    expect(normalizePairs(run)).toEqual(run);
  });

  test("moves results next to their call, answers open calls and drops strays", () => {
    const fixed = normalizePairs([
      result("stray"),
      prompt("x"),
      call("a", "b"),
      note("between"),
      result("a"),
      result("zzz"),
    ]);
    expect(checkView(fixed)).toEqual([]);
    expect(fixed.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "user"]);
    const missing = fixed[3];
    expect(missing?.role === "tool" && missing.toolCallId).toBe("b");
    expect(missing?.role === "tool" && missing.isError).toBe(true);
  });
});
