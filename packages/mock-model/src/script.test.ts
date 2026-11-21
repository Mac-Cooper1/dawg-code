import { describe, expect, test } from "vitest";
import {
  contextOverflow,
  dropped,
  httpError,
  malformedToolCall,
  reasoning,
  stalled,
  text,
  toolCall,
} from "./builders.ts";
import { matches, parseScript, ScriptError } from "./script.ts";
import type { RecordedRequest } from "./types.ts";

function request(body: unknown): RecordedRequest {
  return {
    index: 0,
    method: "POST",
    path: "/v1/chat/completions",
    headers: {},
    body,
    rawBody: JSON.stringify(body),
  };
}

describe("parseScript", () => {
  test("accepts an array of replies or an object with lanes, and every builder's output", () => {
    const replies = [
      text("hi"),
      reasoning("hmm", "ok"),
      toolCall("Read", { file_path: "/x" }),
      malformedToolCall("Edit", "{"),
      dropped(),
      stalled(),
      httpError(500, "boom"),
      contextOverflow(10, 5),
    ];
    // A round trip through JSON proves the builders produce plain data.
    expect(parseScript(JSON.parse(JSON.stringify(replies)))).toEqual({ replies });
    const script = {
      replies: [text("a")],
      lanes: { title: { match: { system: "title", hasTools: false }, replies: [text("T")] } },
    };
    expect(parseScript(script)).toEqual(script);
  });

  test.each([
    [[{ txt: "typo" }], "replies[0].txt: is not a reply field"],
    [[{ text: 3 }], "replies[0].text: must be a string or an array of strings"],
    [[{ toolCalls: [{ arguments: "{}" }] }], "replies[0].toolCalls[0].name: must be a string"],
    [[{ fault: { type: "explode" } }], "replies[0].fault.type: must be one of"],
    [[{ fault: { type: "http", status: 42 } }], "replies[0].fault.status: must be an HTTP status"],
    [[{ pacing: { chunkSize: 0 } }], "replies[0].pacing.chunkSize: must be a number >= 1"],
    [[{ wire: { lineEnding: "cr" } }], 'replies[0].wire.lineEnding: must be "lf" or "crlf"'],
    [{ lanes: { main: { match: {} } } }, 'lanes.main: "main" is reserved'],
    [{ lanes: { t: { match: { nope: 1 } } } }, "lanes.t.match.nope: is not a matcher field"],
    [{ replyz: [] }, "script.replyz: is not a script field"],
    ["text", "script: must be an array of replies or an object"],
  ])("rejects %j", (input, message) => {
    expect(() => parseScript(input)).toThrow(ScriptError);
    expect(() => parseScript(input)).toThrow(message);
  });
});

describe("matches", () => {
  const body = {
    messages: [
      { role: "system", content: "You write titles." },
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second question" },
    ],
    tools: [{ type: "function", function: { name: "Read" } }],
    max_tokens: 30,
  };

  test("every given field must match", () => {
    expect(matches({ system: "titles" }, request(body))).toBe(true);
    expect(matches({ system: "agent" }, request(body))).toBe(false);
    expect(matches({ lastUser: "second" }, request(body))).toBe(true);
    expect(matches({ lastUser: "first" }, request(body))).toBe(false);
    expect(matches({ hasTools: true, maxTokensAtMost: 30 }, request(body))).toBe(true);
    expect(matches({ hasTools: false }, request(body))).toBe(false);
    expect(matches({ maxTokensAtMost: 10 }, request(body))).toBe(false);
    expect(matches({ bodyIncludes: '"Read"' }, request(body))).toBe(true);
    expect(matches({}, request(body))).toBe(true);
  });

  test("function matchers get the recorded request", () => {
    expect(matches((r) => r.path.endsWith("/completions"), request(body))).toBe(true);
  });
});
