import { describe, expect, test } from "vitest";
import type { Message } from "../contracts/messages.ts";
import { createCompactor } from "./compact.ts";
import { createTokenEstimator } from "./estimate.ts";
import { headAndTail, trimLargestResult } from "./trim.ts";
import { checkView } from "./view.ts";

const estimator = createTokenEstimator();
const tokens = (messages: readonly Message[]) => estimator.estimate({ messages, tools: [] });

const prompt = (text: string): Message => ({
  role: "user",
  kind: "prompt",
  content: [{ type: "text", text }],
});
const call = (id: string, name = "Bash"): Message => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, name, arguments: '{"command":"npm test"}' }],
});
const result = (id: string, text: string): Message => ({
  role: "tool",
  toolCallId: id,
  toolName: "Bash",
  content: [{ type: "text", text }],
  isError: false,
});

const logLines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag} line ${i}: test case passed in ${i % 97} ms`).join(
    "\n",
  );

describe("trimLargestResult", () => {
  test("shortens one huge result to its head and tail and brings the history under the target", () => {
    const huge = `${logLines(3_000, "run")}\nFAILED: 1 test. The full output is saved in /tmp/out.txt.`;
    const history: Message[] = [
      prompt("run the tests"),
      call("a"),
      result("a", "small output"),
      call("b"),
      result("b", huge),
    ];
    const target = Math.floor(tokens(history) / 4);
    const trimmed = trimLargestResult(history, target, estimator);
    expect(trimmed).not.toBeNull();
    if (trimmed === null) return;
    expect(tokens(trimmed)).toBeLessThanOrEqual(target);
    expect(checkView(trimmed)).toEqual([]);
    // Only that result changed; everything else is the same object.
    for (const i of [0, 1, 2, 3]) expect(trimmed[i]).toBe(history[i]);
    const text = trimmed[4]?.role === "tool" ? trimmed[4].content[0] : undefined;
    expect(text?.type === "text" && text.text.startsWith("run line 0:")).toBe(true);
    expect(text?.type === "text" && text.text.endsWith("saved in /tmp/out.txt.")).toBe(true);
    expect(text?.type === "text" && text.text).toMatch(/lines \(\d+ characters\) were cut/);
    const trimmedResult = trimmed[4];
    expect(trimmedResult?.role === "tool" && trimmedResult.toolCallId).toBe("b");
  });

  test("does nothing when the history is already under the target", () => {
    const history = [prompt("hi"), call("a"), result("a", "ok")];
    expect(trimLargestResult(history, 10_000, estimator)).toBeNull();
  });

  test("does nothing when no single result is the problem", () => {
    const history: Message[] = [prompt("go")];
    for (let i = 0; i < 10; i++)
      history.push(call(`c${i}`), result(`c${i}`, logLines(200, `r${i}`)));
    // Cutting the largest result to the minimum still leaves the history far over this target.
    expect(trimLargestResult(history, Math.floor(tokens(history) / 3), estimator)).toBeNull();
  });

  test("does nothing without tool results", () => {
    const history = [prompt(logLines(5_000, "pasted"))];
    expect(trimLargestResult(history, 100, estimator)).toBeNull();
  });

  test("is what the compactor offers", () => {
    const history = [prompt("go"), call("a"), result("a", logLines(4_000, "x"))];
    const compactor = createCompactor({ estimator });
    const target = Math.floor(tokens(history) / 3);
    expect(compactor.trimLargestResult(history, target)).toEqual(
      trimLargestResult(history, target, estimator),
    );
  });
});

describe("headAndTail", () => {
  test("keeps text that already fits", () => {
    expect(headAndTail("short", 100)).toBe("short");
  });

  test("cuts at line breaks and says how much went", () => {
    const text = logLines(100, "l");
    const out = headAndTail(text, 1_000);
    expect(out.length).toBeLessThan(1_400);
    expect(out.startsWith("l line 0:")).toBe(true);
    expect(out.endsWith("l line 99: test case passed in 2 ms")).toBe(true);
    expect(out).toMatch(/\n\[… \d+ lines \(\d+ characters\) were cut/);
  });
});
