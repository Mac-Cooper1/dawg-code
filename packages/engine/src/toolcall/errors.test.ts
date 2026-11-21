/**
 * The exact texts the model receives. Each snapshot was read and judged for clarity: it names the
 * tool, the field and the problem, shows what was sent, and says what to do next.
 */
import { describe, expect, test } from "vitest";
import type { FinishReason, RawToolCall } from "../contracts/model.ts";
import { TOOLS } from "./__fixtures__/tools.ts";
import { previewArguments, TRUNCATED_UNNAMED_CALL_NOTICE } from "./errors.ts";
import { prepareToolCalls } from "./pipeline.ts";

function errorFor(name: string, args: string, finish: FinishReason = "tool_calls"): string {
  const call: RawToolCall = { id: "c1", name, arguments: args };
  const reply = prepareToolCalls({ content: "", toolCalls: [call], finishReason: finish }, TOOLS, {
    newId: () => "x",
  });
  const c = reply.calls[0];
  if (c === undefined || c.status === "ready") throw new Error("expected an error");
  return c.error;
}

function errorForText(content: string, finish: FinishReason = "stop"): string {
  const reply = prepareToolCalls({ content, toolCalls: [], finishReason: finish }, TOOLS, {
    newId: () => "x",
  });
  const c = reply.calls[0];
  if (c === undefined || c.status === "ready") throw new Error("expected an error");
  return c.error;
}

describe("error texts", () => {
  test("wrong types and a missing field", () => {
    expect(errorFor("Read", '{"offset": "ten", "limit": 2.5}')).toMatchInlineSnapshot(`
      "Read was not run: its arguments do not match its input schema.
      - \`file_path\`: required but missing
      - \`offset\`: expected an integer, got the string "ten"
      - \`limit\`: expected an integer, got 2.5
      Read takes: file_path (string, required), offset (integer), limit (integer).
      You sent: {"offset":"ten","limit":2.5}
      Fix the arguments and call Read again."
    `);
  });

  test("an unknown field with a likely meaning", () => {
    expect(errorFor("Read", '{"path": "/src/app.ts"}')).toMatchInlineSnapshot(`
      "Read was not run: its arguments do not match its input schema.
      - \`file_path\`: required but missing
      - \`path\`: is not a field of Read; did you mean \`file_path\`?
      Read takes: file_path (string, required), offset (integer), limit (integer).
      You sent: {"path":"/src/app.ts"}
      Fix the arguments and call Read again."
    `);
  });

  test("a field sent twice under two spellings", () => {
    expect(errorFor("Read", '{"file_path": "/a.ts", "filePath": "/b.ts"}')).toMatchInlineSnapshot(`
      "Read was not run: its arguments do not match its input schema.
      - \`filePath\`: is not a field of Read; it differs from \`file_path\` only in case or punctuation, but another value for \`file_path\` was also sent. Send the value once, as \`file_path\`
      Read takes: file_path (string, required), offset (integer), limit (integer).
      You sent: {"file_path":"/a.ts","filePath":"/b.ts"}
      Fix the arguments and call Read again."
    `);
  });

  test("a nested problem in a list", () => {
    expect(
      errorFor(
        "TodoWrite",
        JSON.stringify({
          todos: [
            { content: "Fix the bug", status: "done", activeForm: "Fixing the bug" },
            { content: "Run tests", status: "pending" },
          ],
        }),
      ),
    ).toMatchInlineSnapshot(`
      "TodoWrite was not run: its arguments do not match its input schema.
      - \`todos[0].status\`: must be one of "pending", "in_progress", "completed"; got the string "done"
      - \`todos[1].activeForm\`: required but missing
      TodoWrite takes: todos (array of objects, required).
      You sent: {"todos":[{"content":"Fix the bug","status":"done","activeForm":"Fixing the bug"},{"content":"Run tests","status":"pending"}]}
      Fix the arguments and call TodoWrite again."
    `);
  });

  test("a single object where the whole list was expected", () => {
    expect(
      errorFor(
        "TodoWrite",
        '{"todos": {"content": "Fix the bug", "status": "pending", "activeForm": "Fixing"}}',
      ),
    ).toMatchInlineSnapshot(`
      "TodoWrite was not run: its arguments do not match its input schema.
      - \`todos\`: expected an array, got an object
      TodoWrite takes: todos (array of objects, required).
      You sent: {"todos":{"content":"Fix the bug","status":"pending","activeForm":"Fixing"}}
      Fix the arguments and call TodoWrite again."
    `);
  });

  test("a long value is shortened in what was sent", () => {
    const content = "import fs from 'node:fs';\n".repeat(200);
    expect(errorFor("Write", JSON.stringify({ path: "/a.ts", content }))).toMatchInlineSnapshot(`
      "Write was not run: its arguments do not match its input schema.
      - \`file_path\`: required but missing
      - \`path\`: is not a field of Write; did you mean \`file_path\`?
      Write takes: file_path (string, required), content (string, required).
      You sent: {"path":"/a.ts","content":"import fs from 'node:fs';\\nimport fs from 'node:fs';\\nimport f…" (5200 characters)}
      Fix the arguments and call Write again."
    `);
  });

  test("a tool that takes nothing", () => {
    expect(errorFor("EnterPlanMode", '{"reason": "large change"}')).toMatchInlineSnapshot(`
      "EnterPlanMode was not run: its arguments do not match its input schema.
      - \`reason\`: is not a field of EnterPlanMode, which takes no fields
      EnterPlanMode takes: no arguments (send {}).
      You sent: {"reason":"large change"}
      Fix the arguments and call EnterPlanMode again."
    `);
  });

  test("invalid JSON", () => {
    expect(
      errorFor("Edit", '{"file_path": "/a.ts", "old_string": "a" "new_string": "b"}'),
    ).toMatchInlineSnapshot(`
      "Edit was not run: its arguments are not valid JSON: expected "," or "}" after a value (near \`….ts", "old_string": "a" "new_string": "b"}\`).
      Edit takes: file_path (string, required), old_string (string, required), new_string (string, required), replace_all (boolean).
      You sent: {"file_path": "/a.ts", "old_string": "a" "new_string": "b"}
      Send the arguments as one JSON object and call Edit again."
    `);
  });

  test("JSON cut off although the reply finished", () => {
    expect(errorFor("Bash", '{"command": "npm run te')).toMatchInlineSnapshot(`
      "Bash was not run: its arguments are not valid JSON: it ends in the middle of a string (near \`{"command": "npm run te\`).
      Bash takes: command (string, required), timeout (integer), run_in_background (boolean), description (string).
      You sent: {"command": "npm run te
      Send the arguments as one JSON object and call Bash again."
    `);
  });

  test("two objects run together", () => {
    expect(errorFor("Bash", '{"command": "ls"}{"command": "pwd"}')).toMatchInlineSnapshot(`
      "Bash was not run: its arguments hold more than one JSON object (near \`{"command": "ls"}{"command": "pwd"}\`). Send one object per call, and make a separate call for each action.
      Bash takes: command (string, required), timeout (integer), run_in_background (boolean), description (string).
      You sent: {"command": "ls"}{"command": "pwd"}
      Send the arguments as one JSON object and call Bash again."
    `);
  });

  test("not an object", () => {
    expect(errorFor("Glob", '["*.ts"]')).toMatchInlineSnapshot(`
      "Glob was not run: its arguments must be a JSON object ({...}), but they are an array.
      Glob takes: pattern (string, required), path (string).
      You sent: ["*.ts"]
      Send the arguments as one JSON object and call Glob again."
    `);
  });

  test("conflicting duplicate fields", () => {
    expect(errorFor("Bash", '{"command": "ls", "command": "rm -rf build"}')).toMatchInlineSnapshot(`
      "Bash was not run: its arguments are ambiguous: the field "command" appears more than once with different values (near \`{"command": "ls", "command": "rm -rf build…\`).
      Bash takes: command (string, required), timeout (integer), run_in_background (boolean), description (string).
      You sent: {"command": "ls", "command": "rm -rf build"}
      Send the arguments as one JSON object and call Bash again."
    `);
  });

  test("truncated by the output limit", () => {
    expect(
      errorFor("Write", '{"file_path": "/a.ts", "content": "export const', "length"),
    ).toMatchInlineSnapshot(`
      "Write was not run: the reply reached the output length limit while this call was being written, so its arguments are incomplete.
      Send less in one call: split long content over several calls (for example, write the first part of a file, then add the rest with further edits)."
    `);
  });

  test("unknown tool with a suggestion", () => {
    expect(errorFor("read_file", '{"path": "/a"}')).toMatchInlineSnapshot(`
      "There is no tool named "read_file", so nothing was run. Did you mean Read?
      Available tools: Read, Write, Edit, Bash, Glob, Grep, TodoWrite, EnterPlanMode, ExitPlanMode, web_search."
    `);
  });

  test("unknown tool without a suggestion", () => {
    expect(errorFor("list_directory", "{}")).toMatchInlineSnapshot(`
      "There is no tool named "list_directory", so nothing was run.
      Available tools: Read, Write, Edit, Bash, Glob, Grep, TodoWrite, EnterPlanMode, ExitPlanMode, web_search."
    `);
  });

  test("a call in the text that could not be read", () => {
    expect(
      errorForText(
        "<tool_call>\n<function=Edit>\n<parameter=file_path>\n/a\n</parameter>\nstray words\n<parameter=old_string>\nx\n</parameter>\n</function>\n</tool_call>",
      ),
    ).toMatchInlineSnapshot(`
      "Edit was not run: a call to it was found in the reply's text, but it could not be read (there is text between the parameters that is not a <parameter=...> tag).
      Edit takes: file_path (string, required), old_string (string, required), new_string (string, required), replace_all (boolean).
      Call Edit again with all of its arguments."
    `);
  });

  test("the notice for a reply cut off before a tool was named", () => {
    expect(TRUNCATED_UNNAMED_CALL_NOTICE).toMatchInlineSnapshot(
      `"Your last reply reached the output length limit while it was starting a tool call, so no tool was run. Send less in one call: split long content over several calls."`,
    );
  });

  test("the same mistake always gives the same text", () => {
    const a = errorFor("Read", '{"offset": "ten"}');
    const b = errorFor("Read", '{"offset": "ten"}');
    expect(a).toBe(b);
  });
});

describe("previewArguments", () => {
  test("shortens long strings, long lists and deep nesting", () => {
    expect(
      previewArguments({
        s: "y".repeat(100),
        list: [1, 2, 3, 4, 5, 6, 7],
        deep: { a: { b: { c: { d: 1 } } } },
      }),
    ).toMatchInlineSnapshot(
      `"{"s":"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy…" (100 characters),"list":[1,2,3,4,5,… 2 more],"deep":{"a":{"b":{…}}}}"`,
    );
  });
});
