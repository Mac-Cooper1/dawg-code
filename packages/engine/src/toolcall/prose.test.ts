import { describe, expect, test } from "vitest";
import type { FinishReason } from "../contracts/model.ts";
import { TOOLS } from "./__fixtures__/tools.ts";
import { type ProseFormat, recoverProseCalls } from "./prose.ts";

interface Found {
  name: string;
  /** The recovered argument text, parsed (or "" when it was empty). */
  args: Record<string, unknown> | "";
  format: ProseFormat;
  unterminated?: boolean;
  failure?: string;
}

interface Positive {
  name: string;
  content: string;
  calls: Found[];
  cleaned: string;
  finish?: FinishReason;
}

const NL = "\n";

const positives: Positive[] = [
  // Qwen3.6 / Qwen3.8 chat templates
  {
    name: "Qwen XML call after prose",
    content:
      "I'll read the file.\n\n<tool_call>\n<function=Read>\n<parameter=file_path>\n/src/app.ts\n</parameter>\n</function>\n</tool_call>",
    calls: [{ name: "Read", args: { file_path: "/src/app.ts" }, format: "tool_call_xml" }],
    cleaned: "I'll read the file.",
  },
  {
    name: "Qwen XML keeps a value's own whitespace, minus the template's newlines",
    content:
      "<tool_call>\n<function=Write>\n<parameter=file_path>\n/a.py\n</parameter>\n<parameter=content>\n\ndef f():\n    return 1\n\n</parameter>\n</function>\n</tool_call>",
    calls: [
      {
        name: "Write",
        args: { file_path: "/a.py", content: "\ndef f():\n    return 1\n" },
        format: "tool_call_xml",
      },
    ],
    cleaned: "",
  },
  {
    name: "Qwen XML values stay strings for the validator to coerce",
    content:
      "<tool_call>\n<function=Read>\n<parameter=file_path>\n/a\n</parameter>\n<parameter=limit>\n50\n</parameter>\n</function>\n</tool_call>",
    calls: [{ name: "Read", args: { file_path: "/a", limit: "50" }, format: "tool_call_xml" }],
    cleaned: "",
  },
  {
    name: "Qwen XML, two calls",
    content:
      "<tool_call>\n<function=Glob>\n<parameter=pattern>\n**/*.ts\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=Grep>\n<parameter=pattern>\nTODO\n</parameter>\n</function>\n</tool_call>",
    calls: [
      { name: "Glob", args: { pattern: "**/*.ts" }, format: "tool_call_xml" },
      { name: "Grep", args: { pattern: "TODO" }, format: "tool_call_xml" },
    ],
    cleaned: "",
  },
  {
    name: "Qwen XML missing </parameter> before the next parameter",
    content:
      "<tool_call>\n<function=Edit>\n<parameter=file_path>\n/a\n<parameter=old_string>\nx\n</parameter>\n<parameter=new_string>\ny\n</parameter>\n</function>\n</tool_call>",
    calls: [
      {
        name: "Edit",
        args: { file_path: "/a", old_string: "x", new_string: "y" },
        format: "tool_call_xml",
      },
    ],
    cleaned: "",
  },
  {
    name: "Qwen XML missing </tool_call> at the end of a finished reply",
    content: "<tool_call>\n<function=Read>\n<parameter=file_path>\n/a\n</parameter>\n</function>",
    calls: [
      { name: "Read", args: { file_path: "/a" }, format: "tool_call_xml", unterminated: true },
    ],
    cleaned: "",
  },
  {
    name: "Qwen XML without the <tool_call> wrapper",
    content: "Checking.\n<function=Read>\n<parameter=file_path>\n/a\n</parameter>\n</function>",
    calls: [{ name: "Read", args: { file_path: "/a" }, format: "function_tag" }],
    cleaned: "Checking.",
  },

  // Hermes-style JSON (Qwen2.5, Qwen3 2504 and many fine-tunes)
  {
    name: "JSON in <tool_call> tags",
    content: '<tool_call>\n{"name": "Bash", "arguments": {"command": "npm test"}}\n</tool_call>',
    calls: [{ name: "Bash", args: { command: "npm test" }, format: "tool_call_json" }],
    cleaned: "",
  },
  {
    name: "JSON in <tool_call> tags using parameters",
    content: '<tool_call>{"name": "Glob", "parameters": {"pattern": "*.md"}}</tool_call>',
    calls: [{ name: "Glob", args: { pattern: "*.md" }, format: "tool_call_json" }],
    cleaned: "",
  },
  {
    name: "JSON in <tool_call> tags with double-encoded arguments",
    content: '<tool_call>{"name": "Glob", "arguments": "{\\"pattern\\": \\"*.md\\"}"}</tool_call>',
    calls: [{ name: "Glob", args: { pattern: "*.md" }, format: "tool_call_json" }],
    cleaned: "",
  },
  {
    name: "JSON in <tool_call> tags with no arguments",
    content: '<tool_call>{"name": "EnterPlanMode"}</tool_call>',
    calls: [{ name: "EnterPlanMode", args: "", format: "tool_call_json" }],
    cleaned: "",
  },
  {
    name: "JSON in <tool_call> tags, unknown tool still recovered",
    content: '<tool_call>{"name": "read_file", "arguments": {"path": "/a"}}</tool_call>',
    calls: [{ name: "read_file", args: { path: "/a" }, format: "tool_call_json" }],
    cleaned: "",
  },
  {
    name: "broken JSON in <tool_call> tags is reported, not ignored",
    content: '<tool_call>{"name": "Read", "arguments": {"file_path": "/a"</tool_call>',
    calls: [
      {
        name: "Read",
        args: "",
        format: "tool_call_json",
        failure: "the JSON inside <tool_call> is not valid",
      },
    ],
    cleaned: "",
  },

  // Laguna (and GLM-style templates)
  {
    name: "Laguna arg tags",
    content:
      "Let me look.<tool_call>Read<arg_key>file_path</arg_key><arg_value>/a.ts</arg_value><arg_key>limit</arg_key><arg_value>20</arg_value></tool_call>",
    calls: [
      { name: "Read", args: { file_path: "/a.ts", limit: "20" }, format: "tool_call_arg_tags" },
    ],
    cleaned: "Let me look.",
  },
  {
    name: "Laguna arg tags keep values verbatim",
    content:
      "<tool_call>Write<arg_key>file_path</arg_key><arg_value>/a</arg_value><arg_key>content</arg_key><arg_value>\n  x\n</arg_value></tool_call>",
    calls: [
      {
        name: "Write",
        args: { file_path: "/a", content: "\n  x\n" },
        format: "tool_call_arg_tags",
      },
    ],
    cleaned: "",
  },
  {
    name: "GLM-style arg tags with newlines between tags",
    content:
      "<tool_call>Grep\n<arg_key>pattern</arg_key>\n<arg_value>foo</arg_value>\n<arg_key>-i</arg_key>\n<arg_value>true</arg_value>\n</tool_call>",
    calls: [{ name: "Grep", args: { pattern: "foo", "-i": "true" }, format: "tool_call_arg_tags" }],
    cleaned: "",
  },
  {
    name: "arg tags with no arguments, for a known tool",
    content: "<tool_call>EnterPlanMode</tool_call>",
    calls: [{ name: "EnterPlanMode", args: "", format: "tool_call_arg_tags" }],
    cleaned: "",
  },
  {
    name: "arg tags with an unclosed value",
    content:
      "<tool_call>Read<arg_key>file_path</arg_key><arg_value>/a</tool_call>\nMore text after.",
    calls: [
      {
        name: "Read",
        args: "",
        format: "tool_call_arg_tags",
        failure: "is not closed with </arg_value>",
      },
    ],
    cleaned: "More text after.",
  },

  // gpt-oss harmony
  {
    name: "harmony commentary call",
    content:
      '<|start|>assistant<|channel|>commentary to=functions.Read <|constrain|>json<|message|>{"file_path":"/a"}<|call|>',
    calls: [{ name: "Read", args: { file_path: "/a" }, format: "harmony" }],
    cleaned: "",
  },
  {
    name: "harmony call in the analysis channel",
    content:
      'Let me check.<|start|>assistant<|channel|>analysis to=functions.Grep <|constrain|>json<|message|>{"pattern": "release notes"}<|call|>',
    calls: [{ name: "Grep", args: { pattern: "release notes" }, format: "harmony" }],
    cleaned: "Let me check.",
  },
  {
    name: "harmony with the recipient before the channel",
    content:
      '<|start|>assistant to=functions.Bash<|channel|>commentary json<|message|>{"command": "ls"}<|call|>',
    calls: [{ name: "Bash", args: { command: "ls" }, format: "harmony" }],
    cleaned: "",
  },
  {
    name: "harmony with the stop token stripped",
    content: '<|channel|>commentary to=functions.Glob <|constrain|>json<|message|>{"pattern":"*"}',
    calls: [{ name: "Glob", args: { pattern: "*" }, format: "harmony", unterminated: true }],
    cleaned: "",
  },
  {
    name: "harmony after an analysis message",
    content:
      '<|channel|>analysis<|message|>Need to read.<|end|><|start|>assistant<|channel|>commentary to=functions.Read <|constrain|>json<|message|>{"file_path":"/b"}<|call|>',
    calls: [{ name: "Read", args: { file_path: "/b" }, format: "harmony" }],
    cleaned: "<|channel|>analysis<|message|>Need to read.<|end|>",
  },

  // Llama 3.x
  {
    name: "Llama function tag with JSON",
    content: '<function=Bash>{"command": "git status"}</function>',
    calls: [{ name: "Bash", args: { command: "git status" }, format: "function_tag" }],
    cleaned: "",
  },

  // Mistral
  {
    name: "Mistral call list",
    content: '[TOOL_CALLS] [{"name": "Glob", "arguments": {"pattern": "**/*.ts"}}]',
    calls: [{ name: "Glob", args: { pattern: "**/*.ts" }, format: "mistral" }],
    cleaned: "",
  },
  {
    name: "Mistral name and [ARGS]",
    content: '[TOOL_CALLS]Glob[ARGS]{"pattern": "**/*.ts"}',
    calls: [{ name: "Glob", args: { pattern: "**/*.ts" }, format: "mistral" }],
    cleaned: "",
  },
  {
    name: "Mistral with a call id, two calls",
    content:
      '[TOOL_CALLS]Read[CALL_ID]a1b2c3d4e[ARGS]{"file_path": "/a"}[TOOL_CALLS]Read[ARGS]{"file_path": "/b"}',
    calls: [
      { name: "Read", args: { file_path: "/a" }, format: "mistral" },
      { name: "Read", args: { file_path: "/b" }, format: "mistral" },
    ],
    cleaned: "",
  },

  // Plain JSON
  {
    name: "fenced JSON naming a known tool",
    content:
      'I need to see the file.\n```json\n{"name": "Read", "arguments": {"file_path": "/a"}}\n```',
    calls: [{ name: "Read", args: { file_path: "/a" }, format: "fenced_json" }],
    cleaned: "I need to see the file.",
  },
  {
    name: "fenced JSON in the OpenAI wrapper",
    content:
      '```\n{"type": "function", "function": {"name": "Bash", "arguments": "{\\"command\\": \\"ls\\"}"}}\n```',
    calls: [{ name: "Bash", args: { command: "ls" }, format: "fenced_json" }],
    cleaned: "",
  },
  {
    name: "fenced JSON list of calls",
    content:
      '```json\n[{"name": "Read", "input": {"file_path": "/a"}}, {"name": "Read", "input": {"file_path": "/b"}}]\n```',
    calls: [
      { name: "Read", args: { file_path: "/a" }, format: "fenced_json" },
      { name: "Read", args: { file_path: "/b" }, format: "fenced_json" },
    ],
    cleaned: "",
  },
  {
    name: "whole reply is a call object",
    content: '  {"name": "Bash", "arguments": {"command": "ls"}}\n',
    calls: [{ name: "Bash", args: { command: "ls" }, format: "bare_json" }],
    cleaned: "",
  },
  {
    name: "text before and after a call",
    content:
      'First.\n\n<tool_call>\n{"name": "Bash", "arguments": {"command": "ls"}}\n</tool_call>\n\nThen more.',
    calls: [{ name: "Bash", args: { command: "ls" }, format: "tool_call_json" }],
    cleaned: "First.\n\nThen more.",
  },
  {
    name: "a call after a code example is still found",
    content:
      'Example:\n```xml\n<tool_call>{"name": "Bash"}</tool_call>\n```\n<tool_call>{"name": "Bash", "arguments": {"command": "ls"}}</tool_call>',
    calls: [{ name: "Bash", args: { command: "ls" }, format: "tool_call_json" }],
    cleaned: 'Example:\n```xml\n<tool_call>{"name": "Bash"}</tool_call>\n```',
  },
  {
    name: "a fence inside a parameter value does not hide later calls",
    content:
      "<tool_call>\n<function=Write>\n<parameter=file_path>\n/a.md\n</parameter>\n<parameter=content>\n```js\nopen fence only\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=Read>\n<parameter=file_path>\n/b\n</parameter>\n</function>\n</tool_call>",
    calls: [
      {
        name: "Write",
        args: { file_path: "/a.md", content: "```js\nopen fence only" },
        format: "tool_call_xml",
      },
      { name: "Read", args: { file_path: "/b" }, format: "tool_call_xml" },
    ],
    cleaned: "",
  },
];

function check(content: string, finish: FinishReason = "stop") {
  return recoverProseCalls(content, TOOLS, finish);
}

describe("recovers calls written as text", () => {
  test.each(positives)("$name", ({ content, calls, cleaned, finish }) => {
    const r = check(content, finish);
    expect(r.content).toBe(cleaned);
    expect(r.unnamedTruncated).toBe(false);
    expect(
      r.calls.map((c) => ({
        name: c.name,
        args: c.arguments === "" ? "" : JSON.parse(c.arguments),
        format: c.format,
        ...(c.unterminated ? { unterminated: true } : {}),
        ...(c.failure ? { failure: c.failure } : {}),
      })),
    ).toEqual(
      calls.map((c) => ({
        ...c,
        ...(c.failure ? { failure: expect.stringContaining(c.failure) } : {}),
      })),
    );
  });
});

const negatives: { name: string; content: string }[] = [
  { name: "ordinary prose", content: "The tests pass now. Let me know if you need anything else." },
  { name: "prose naming tools", content: "I will use Read to open the file, then Edit to fix it." },
  {
    name: "JSON config example",
    content:
      'Your package.json should look like:\n```json\n{"name": "my-app", "version": "1.0.0"}\n```',
  },
  {
    name: "call-shaped JSON for an unknown tool",
    content: '```json\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n```',
  },
  {
    name: "call-shaped JSON with extra keys",
    content: '```json\n{"name": "Read", "arguments": {"file_path": "/a"}, "result": "ok"}\n```',
  },
  {
    name: "call-shaped JSON in a python block",
    content: '```python\ncall = {"name": "Read", "arguments": {"file_path": "/a"}}\n```',
  },
  {
    name: "call markup inside a code fence",
    content:
      "Qwen writes calls like this:\n```xml\n<tool_call>\n<function=Read>\n<parameter=file_path>\n/a\n</parameter>\n</function>\n</tool_call>\n```",
  },
  {
    name: "call markup in inline code",
    content: 'Wrap it as `<tool_call>{"name": "Read", "arguments": {}}</tool_call>` in the output.',
  },
  {
    name: "call markup in double-backtick inline code",
    content: "Use ``<function=Read>{}</function>`` for Llama.",
  },
  { name: "tags around a sentence", content: "The <tool_call> and </tool_call> tags wrap a call." },
  { name: "function tag in prose", content: "Llama uses the <function=name> syntax for calls." },
  {
    name: "call JSON inline in a sentence",
    content: 'The call {"name": "Read", "arguments": {"file_path": "/a"}} would read it.',
  },
  { name: "harmony recipient in prose", content: "gpt-oss addresses tools as to=functions.Read." },
  { name: "Mistral token in prose", content: "The [TOOL_CALLS] token starts a call list." },
  { name: "a JSON list that is not calls", content: "[1, 2, 3]" },
  { name: "a JSON object that is not a call", content: '{"file_path": "/a"}' },
  { name: "empty", content: "" },
  {
    name: "unfinished opener in a finished reply",
    content: "Let me check.\n<tool_call>\n",
  },
];

describe("leaves prose and examples alone", () => {
  test.each(negatives)("$name", ({ content }) => {
    const r = check(content);
    expect(r.calls).toEqual([]);
    expect(r.content).toBe(content);
    expect(r.unnamedTruncated).toBe(false);
  });
});

describe("cut off by the output limit", () => {
  test("a named call cut inside a parameter is marked unterminated", () => {
    const r = check(
      "<tool_call>\n<function=Write>\n<parameter=file_path>\n/a\n</parameter>\n<parameter=content>\nhalf a fi",
      "length",
    );
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ name: "Write", unterminated: true });
    expect(r.calls[0]?.failure).toContain('"content" is not closed');
  });

  test("a named JSON call cut inside a string is marked unterminated", () => {
    const r = check(
      `<tool_call>${NL}{"name": "Write", "arguments": {"file_path": "/a", "content": "hal`,
      "length",
    );
    expect(r.calls[0]).toMatchObject({ name: "Write", unterminated: true });
  });

  test("the llama-server truncation fixture: a bare opener is removed and flagged", () => {
    const r = check("<tool_call>\n", "length");
    expect(r).toEqual({ calls: [], content: "", unnamedTruncated: true });
  });

  test("an opener cut before the name, after some text", () => {
    const r = check('I will check.\n<tool_call>\n{"na', "length");
    expect(r).toEqual({ calls: [], content: "I will check.", unnamedTruncated: true });
  });

  test("a harmony header cut before the message", () => {
    const r = check("<|start|>assistant<|channel|>commentary to=functions.Re", "length");
    expect(r.unnamedTruncated).toBe(true);
    expect(r.content).toBe("");
  });

  test("a Mistral call cut in its name", () => {
    const r = check("[TOOL_CALLS]Gl", "length");
    expect(r).toEqual({ calls: [], content: "", unnamedTruncated: true });
  });

  test("a complete call before the cut is not marked", () => {
    const r = check(
      '<tool_call>{"name": "Bash", "arguments": {"command": "ls"}}</tool_call>\nNow I will expl',
      "length",
    );
    expect(r.calls[0]).toMatchObject({ name: "Bash", unterminated: false });
  });
});

describe("robustness", () => {
  test("never throws on hostile markup", () => {
    const pieces = [
      "<tool_call>",
      "</tool_call>",
      "<function=",
      "Read>",
      "</function>",
      "<parameter=",
      "x>",
      "</parameter>",
      "[TOOL_CALLS]",
      "[ARGS]",
      "to=functions.",
      "<|message|>",
      "<|call|>",
      "<|channel|>",
      "```",
      "`",
      "{",
      "}",
      '"',
      "\n",
      "<arg_key>",
      "<arg_value>",
    ];
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 2000; i++) {
      let s = "";
      const n = Math.floor(rand() * 12);
      for (let j = 0; j < n; j++) s += pieces[Math.floor(rand() * pieces.length)];
      for (const finish of ["stop", "length"] as const) {
        expect(() => recoverProseCalls(s, TOOLS, finish)).not.toThrow();
      }
    }
  });
});

describe("repetitive output from a model stuck in a loop", () => {
  const cases: [string, string][] = [
    ["repeated openers", "<tool_call>\n".repeat(20_000)],
    ["repeated function tags", "<function=Read>".repeat(20_000)],
    ["repeated harmony recipients", "to=functions.Read ".repeat(20_000)],
    ["repeated Mistral markers", "[TOOL_CALLS]".repeat(20_000)],
    ["a long name after a Mistral marker", `[TOOL_CALLS]${"a".repeat(200_000)} `],
    ["many backticks", "`a".repeat(50_000)],
    ["many empty fences", "```\n```\n".repeat(20_000)],
    [
      "many parameters",
      `<tool_call>\n<function=Write>\n${Array.from({ length: 20_000 }, (_, i) => `<parameter=p${i}>\nx\n`).join("")}`,
    ],
    [
      "many arg tags",
      `<tool_call>Read${Array.from({ length: 20_000 }, (_, i) => `<arg_key>k${i}</arg_key><arg_value>v</arg_value>`).join("")}</tool_call>`,
    ],
  ];
  test.each(cases)("%s", (_, content) => {
    const start = performance.now();
    for (const finish of ["stop", "length"] as const) recoverProseCalls(content, TOOLS, finish);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});
