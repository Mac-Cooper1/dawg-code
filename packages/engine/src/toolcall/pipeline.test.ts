import { describe, expect, test } from "vitest";
import type { FinishReason, RawToolCall } from "../contracts/model.ts";
import { TOOLS } from "./__fixtures__/tools.ts";
import { type PreparedReply, prepareToolCalls } from "./pipeline.ts";
import { isPlainObject } from "./values.ts";

function counter(prefix = "gen") {
  let n = 0;
  return () => `${prefix}_${++n}`;
}

function run(
  toolCalls: RawToolCall[],
  options: { content?: string; finish?: FinishReason; taken?: string[] } = {},
): PreparedReply {
  const taken = new Set(options.taken ?? []);
  const reply = prepareToolCalls(
    {
      content: options.content ?? "",
      toolCalls,
      finishReason: options.finish ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
    },
    TOOLS,
    { newId: counter(), isIdTaken: (id) => taken.has(id) },
  );
  // Whatever happened, every recorded call must be safe to send back to the server.
  for (const c of reply.calls) {
    const parsed = JSON.parse(c.call.arguments);
    expect(isPlainObject(parsed)).toBe(true);
    if (c.status === "ready") expect(parsed).toEqual(c.input);
  }
  return reply;
}

const call = (name: string, args: string, id = "c1"): RawToolCall => ({
  id,
  name,
  arguments: args,
});

describe("structured calls", () => {
  test("a clean call is ready and unchanged", () => {
    const r = run([call("Read", '{"file_path": "/a.ts", "limit": 20}')]);
    expect(r.calls).toHaveLength(1);
    const c = r.calls[0];
    expect(c).toMatchObject({
      status: "ready",
      input: { file_path: "/a.ts", limit: 20 },
      call: { id: "c1", name: "Read", arguments: '{"file_path":"/a.ts","limit":20}' },
      malformed: false,
      fixes: { repairs: [], coercions: [], nameCorrectedFrom: null, proseFormat: null },
    });
    expect(c?.call.rawArguments).toBeUndefined();
    expect(r.malformedCount).toBe(0);
    expect(r.recoveredFromProse).toBe(false);
    expect(r.notice).toBeNull();
  });

  test("formatting-only differences do not keep the raw text", () => {
    const r = run([call("Read", '{\n  "file_path" : "/a.ts",\n  "limit": 5.0\n}')]);
    expect(r.calls[0]?.call).toEqual({
      id: "c1",
      name: "Read",
      arguments: '{"file_path":"/a.ts","limit":5}',
    });
    expect(r.malformedCount).toBe(0);
  });

  test("a repaired call is ready, keeps the raw text and counts as malformed", () => {
    const raw = "{'file_path': '/a.ts', 'limit': 20,}";
    const r = run([call("Read", raw)]);
    expect(r.calls[0]).toMatchObject({
      status: "ready",
      call: { arguments: '{"file_path":"/a.ts","limit":20}', rawArguments: raw },
      fixes: { repairs: ["trailing_comma", "single_quotes"] },
      malformed: true,
    });
    expect(r.malformedCount).toBe(1);
  });

  test("a coerced call is ready, with the coerced input", () => {
    const raw = '{"filePath": "/a.ts", "limit": "20"}';
    const r = run([call("Read", raw)]);
    expect(r.calls[0]).toMatchObject({
      status: "ready",
      input: { file_path: "/a.ts", limit: 20 },
      call: { arguments: '{"file_path":"/a.ts","limit":20}', rawArguments: raw },
      malformed: true,
    });
    expect(r.calls[0]?.fixes.coercions.map((c) => c.kind)).toEqual([
      "renamed_field",
      "integer_from_string",
    ]);
  });

  test("schema failure: invalid, recorded with the model's own fields, error for the model", () => {
    const r = run([call("Read", '{"path": "/a.ts"}')]);
    const c = r.calls[0];
    expect(c).toMatchObject({
      status: "invalid",
      reason: "schema",
      call: { arguments: '{"path":"/a.ts"}' },
    });
    expect(c?.call.rawArguments).toBeUndefined();
    expect(c?.status === "invalid" && c.error).toContain("Read was not run");
    expect(r.malformedCount).toBe(1);
  });

  test("unparseable arguments are recorded as {} with the raw text kept", () => {
    const raw = '{"command": "ls" "description": "list"}';
    const r = run([call("Bash", raw)]);
    expect(r.calls[0]).toMatchObject({
      status: "invalid",
      reason: "unparseable",
      call: { arguments: "{}", rawArguments: raw },
    });
  });

  test("a call cut off inside a string is not run, even when the reply finished normally", () => {
    const raw = '{"file_path": "/a.txt", "content": "first half of the fi';
    const r = run([call("Write", raw)], { finish: "stop" });
    expect(r.calls[0]).toMatchObject({ status: "invalid", reason: "unparseable" });
  });

  test("finish reason length: the last call is truncated even if it parses", () => {
    const r = run(
      [
        call("Read", '{"file_path": "/a"}', "c1"),
        call("Write", '{"file_path": "/b", "content": "only part of it"}', "c2"),
      ],
      { finish: "length" },
    );
    expect(r.calls[0]?.status).toBe("ready");
    expect(r.calls[1]).toMatchObject({
      status: "invalid",
      reason: "truncated",
      call: { id: "c2", name: "Write", arguments: "{}" },
    });
    expect(r.calls[1]?.call.rawArguments).toBe('{"file_path": "/b", "content": "only part of it"}');
    expect(r.calls[1]?.status === "invalid" && r.calls[1].error).toContain("output length limit");
    expect(r.malformedCount).toBe(1);
  });

  test("an unknown tool is reported with the available tools", () => {
    const r = run([call("read_file", '{"path": "/a"}')]);
    expect(r.calls[0]).toMatchObject({
      status: "unknown_tool",
      call: { name: "read_file", arguments: '{"path":"/a"}' },
      malformed: true,
    });
    const error = r.calls[0]?.status === "unknown_tool" ? r.calls[0].error : "";
    expect(error).toContain('There is no tool named "read_file"');
    expect(error).toContain("Did you mean Read?");
    expect(error).toContain("Available tools: Read, Write, Edit,");
  });

  test.each([
    ["bash", "Bash"],
    ["BASH", "Bash"],
    ["todo_write", "TodoWrite"],
    ["Todo-Write", "TodoWrite"],
    ["functions.Glob", "Glob"],
    [" Read ", "Read"],
    ["WebSearch", "web_search"],
  ])("tool name %j is corrected to %j", (given, real) => {
    const args = real === "TodoWrite" ? '{"todos": []}' : "{}";
    const r = run([call(given, args)]);
    expect(r.calls[0]?.call.name).toBe(real);
    expect(r.calls[0]?.fixes.nameCorrectedFrom).toBe(given);
    expect(r.calls[0]?.malformed).toBe(true);
  });

  test.each(["read_file", "ReadFile", "run_shell", "Reed", "search"])(
    "tool name %j is not guessed",
    (given) => {
      const r = run([call(given, "{}")]);
      expect(r.calls[0]?.status).toBe("unknown_tool");
    },
  );

  test("empty arguments run a tool that needs none", () => {
    const r = run([call("EnterPlanMode", "")]);
    expect(r.calls[0]).toMatchObject({ status: "ready", input: {}, call: { arguments: "{}" } });
  });

  test("empty arguments for a tool with required fields name the missing fields", () => {
    const r = run([call("Write", "")]);
    expect(r.calls[0]).toMatchObject({ status: "invalid", reason: "schema" });
    expect(r.calls[0]?.status === "invalid" && r.calls[0].error).toContain(
      "`file_path`: required but missing",
    );
  });
});

describe("ids", () => {
  test("ids the model gave are kept", () => {
    const r = run([
      call("Read", '{"file_path":"/a"}', "x"),
      call("Read", '{"file_path":"/b"}', "y"),
    ]);
    expect(r.calls.map((c) => c.call.id)).toEqual(["x", "y"]);
  });

  test("missing and repeated ids are generated, in order", () => {
    const r = run([
      call("Read", '{"file_path":"/a"}', ""),
      call("Read", '{"file_path":"/b"}', "dup"),
      call("Read", '{"file_path":"/c"}', "dup"),
      call("Read", '{"file_path":"/d"}', ""),
    ]);
    expect(r.calls.map((c) => c.call.id)).toEqual(["gen_1", "dup", "gen_2", "gen_3"]);
  });

  test("ids already used in the session are replaced", () => {
    const r = run([call("Read", '{"file_path":"/a"}', "call_0")], { taken: ["call_0", "gen_1"] });
    expect(r.calls[0]?.call.id).toBe("gen_2");
  });

  test("a generator that repeats itself still yields unique ids", () => {
    const reply = prepareToolCalls(
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [call("Read", "{}", ""), call("Read", "{}", ""), call("Read", "{}", "")],
      },
      TOOLS,
      { newId: () => "same" },
    );
    expect(reply.calls.map((c) => c.call.id)).toEqual(["same", "same-2", "same-3"]);
  });

  test("the same reply and generator give the same result", () => {
    const calls = [call("Read", "{'file_path': '/a'}", ""), call("Bash", '{"command":"ls"}', "")];
    const a = prepareToolCalls(
      { content: "", finishReason: "tool_calls", toolCalls: calls },
      TOOLS,
      {
        newId: counter(),
      },
    );
    const b = prepareToolCalls(
      { content: "", finishReason: "tool_calls", toolCalls: calls },
      TOOLS,
      {
        newId: counter(),
      },
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("calls written as text", () => {
  test("Qwen XML in the content becomes a ready call, and the text is cleaned", () => {
    const r = run([], {
      content:
        "Let me read it.\n\n<tool_call>\n<function=Read>\n<parameter=file_path>\n/a.ts\n</parameter>\n<parameter=limit>\n40\n</parameter>\n</function>\n</tool_call>",
    });
    expect(r.recoveredFromProse).toBe(true);
    expect(r.content).toBe("Let me read it.");
    expect(r.calls[0]).toMatchObject({
      status: "ready",
      input: { file_path: "/a.ts", limit: 40 },
      call: { id: "gen_1", name: "Read" },
      fixes: { proseFormat: "tool_call_xml" },
      malformed: true,
    });
    expect(r.malformedCount).toBe(1);
  });

  test("text is not searched when structured calls exist", () => {
    const content = '<tool_call>{"name": "Bash", "arguments": {"command": "rm -rf /"}}</tool_call>';
    const r = run([call("Read", '{"file_path": "/a"}')], { content });
    expect(r.calls).toHaveLength(1);
    expect(r.content).toBe(content);
    expect(r.recoveredFromProse).toBe(false);
  });

  test("a text call cut off by the output limit is truncated, not run", () => {
    const r = run([], {
      finish: "length",
      content: `<tool_call>\n<function=Write>\n<parameter=file_path>\n/a\n</parameter>\n<parameter=content>\nhalf`,
    });
    expect(r.calls[0]).toMatchObject({ status: "invalid", reason: "truncated" });
  });

  test("an unreadable text call is reported to the model", () => {
    const r = run([], {
      content: "<tool_call>Read<arg_key>file_path</arg_key><arg_value>/a</tool_call>",
    });
    expect(r.calls[0]).toMatchObject({ status: "invalid", reason: "unparseable" });
    expect(r.calls[0]?.status === "invalid" && r.calls[0].error).toContain(
      "found in the reply's text",
    );
  });

  test("a reply cut off at a bare opener gives a notice instead of a call", () => {
    const r = run([], { finish: "length", content: "<tool_call>\n" });
    expect(r.calls).toEqual([]);
    expect(r.content).toBe("");
    expect(r.notice).toContain("output length limit");
  });

  test("an unknown tool written as text is reported", () => {
    const r = run([], {
      content: '<tool_call>{"name": "list_dir", "arguments": {"path": "."}}</tool_call>',
    });
    expect(r.calls[0]?.status).toBe("unknown_tool");
  });

  test("plain prose gives no calls", () => {
    const r = run([], { content: "All done. The tests pass." });
    expect(r).toEqual({
      content: "All done. The tests pass.",
      calls: [],
      recoveredFromProse: false,
      malformedCount: 0,
      notice: null,
    });
  });
});

describe("mixed replies", () => {
  test("each call gets its own outcome and the count adds up", () => {
    const r = run([
      call("Read", '{"file_path": "/a"}', "1"),
      call("Read", '{"file_path": "/a",}', "2"),
      call("Edit", '{"file_path": "/a"}', "3"),
      call("Nope", "{}", "4"),
      call("Bash", "not json", "5"),
    ]);
    expect(r.calls.map((c) => c.status)).toEqual([
      "ready",
      "ready",
      "invalid",
      "unknown_tool",
      "invalid",
    ]);
    expect(r.malformedCount).toBe(4);
  });
});
