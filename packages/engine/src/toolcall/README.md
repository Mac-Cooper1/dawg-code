# Tool-call pipeline

Turns whatever a model emitted as a tool call into either a validated call or the exact
tool-result text the model needs to fix it. Pure functions: no file system, network or clock.
Spec: `docs/specs/phase-2-engine-core.md`, "Tool-call pipeline".

```
prepareToolCalls({ content, toolCalls, finishReason }, tools, { newId, isIdTaken })
  no structured calls?  → recover calls written in the text (prose.ts)
  each call             → resolve the tool name (names.ts)
                        → finish reason "length" and last call? → truncated, not run
                        → parse + repair the argument text (json-parse.ts)
                        → coerce + validate against the schema (coerce.ts, validate.ts)
                        → ready | invalid (+ error text) | unknown_tool (+ error text)
lintToolSchema(tool)    → findings for constructs that break llama.cpp grammars (lint.ts)
```

## What history records

- `ToolCall.arguments` is always compact JSON of an object, keys in the model's order (llama.cpp
  renders stored arguments back into the prompt in that order, so keeping it keeps the prompt
  cache valid). Unusable arguments are recorded as `{}`, because llama-server rejects a request
  whose history holds arguments that are not a JSON object.
- `rawArguments` keeps the model's text when a repair or coercion changed it, or when it could not
  be used. Formatting-only differences (spacing, `5.0` vs `5`) are not kept.
- Ids: a model id is kept unless it is empty, repeats an earlier call in the reply, or
  `isIdTaken` says the session already used it; then `newId()` is called, in call order.
- `malformedCount` counts every call that was not perfect as sent: repaired, coerced, renamed,
  recovered from text, invalid, truncated or for an unknown tool.

## Argument repairs

Strict JSON is tried first; a valid object is never marked repaired. Repairs never invent a value.

| Repair               | Example                                | Result                       |
| -------------------- | -------------------------------------- | ---------------------------- |
| `empty_arguments`    | `""`, `"  "`, `"null"`                 | `{}` (then schema decides)   |
| `trailing_comma`     | `{"a": 1,}`, `[1, 2,]`                 | comma dropped                |
| `missing_closer`     | `{"a": "x"` , `{"t": [{"b": true}`     | `}` / `]` added              |
| `extra_closer`       | `{"a": 1}}`                            | surplus closer dropped       |
| `code_fence`         | ` ```json\n{...}\n``` `                | fences dropped               |
| `surrounding_text`   | `Here you go: {...} Hope it helps`     | prose dropped                |
| `double_encoded`     | `"{\"a\": 1}"`                         | decoded once                 |
| `single_quotes`      | `{'a': 'b'}`                           | read as strings              |
| `python_literals`    | `True`, `False`, `None`                | `true`, `false`, `null`      |
| `unquoted_keys`      | `{file_path: "x"}`                     | key read as a string         |
| `control_characters` | raw newline or tab inside a string     | kept as that character       |
| `invalid_escape`     | `"\d+"`, `"C:\users"`, `"it\'s"`       | `\d+`, `C:\users`, `it's`    |

**Refused** (the call is not run and the model is told why):

| Case                                                             | Why                                        |
| ---------------------------------------------------------------- | ------------------------------------------ |
| Text ends inside a string, number, key, escape or literal        | Closing it would run half a value          |
| Text ends right after `{`, `[`, `,` or `:`                       | A value or field was still coming          |
| Any call while the reply's finish reason is `length` (last call) | Cut by the output limit, even if it parses |
| Two objects run together (`{...}{...}`)                          | Usually two calls; picking one is a guess  |
| A field twice with different values                              | Either could be the intended one           |
| Not an object (array, string, number)                            | Arguments are always an object             |
| `NaN`, `undefined`, `+1`, `.5`, `01`, missing commas or colons   | Not JSON, and no single safe reading       |

A number at the end of the text is always treated as cut off (`10` might have been `100`); a
complete object never ends with one.

## Coercions

Applied only where the schema allows exactly one reading; otherwise the value is left for
validation to report. Ajv's own `coerceTypes` is not used because it also turns `null` into `""`
or `0` and numbers into strings.

| Sent                                          | Schema wants                     | Result                       |
| --------------------------------------------- | -------------------------------- | ---------------------------- |
| `"10"`, `" 10 "`, `"10.0"`, `"1e3"`           | integer (safe range)             | `10`, `10`, `10`, `1000`     |
| `"0.25"`                                      | number                           | `0.25`                       |
| `"true"`, `"False"` (any case)                | boolean                          | `true`, `false`              |
| `5.0`                                         | integer                          | already the integer `5`      |
| `'["a", "b"]'`, `"['a']"`                     | array                            | the decoded array            |
| `'{"safe": true}'`                            | object                           | the decoded object           |
| `"a.com"`, `2024`, `true`                     | array of that scalar type        | `["a.com"]`, `[2024]`        |
| `null` for an optional field                  | a type without null              | field dropped                |
| `filePath`, `FilePath`, `file-path`           | `file_path` (closed object)      | renamed, position kept       |
| `filePath` beside `file_path`, same value     | `file_path`                      | duplicate dropped            |
| `"In Progress"`, `"Content"`                  | enum `in_progress`, `content`    | the enum value               |
| `anyOf: [X, {type: null}]`                    | X or null                        | coerced as X                 |

**Refused:**

| Sent                                               | Schema wants          | Why                                                |
| -------------------------------------------------- | --------------------- | -------------------------------------------------- |
| `"ten"`, `"1,000"`, `"0x10"`, `""`, `"30s"`         | integer / number      | Not a plain decimal number                         |
| `"10.5"`, `10.5`                                   | integer               | Has a fraction                                     |
| `"12345678901234567890"`                           | integer               | Beyond exact integer precision                     |
| `"yes"`, `"1"`, `1`                                | boolean               | Not `true`/`false`                                 |
| `42`, `1.5`, `true`                                | string                | Text could differ (`1.50` → `"1.5"`)               |
| `null`                                             | required field        | No value to use                                    |
| `["/a"]`                                           | string                | Unwrapping could drop items                        |
| `{...}` (one object)                               | array of objects      | For a whole-list tool it would drop the other items |
| `'["a", '` (broken list text)                      | array                 | Wrapping it as one item would be a guess           |
| `path` for `file_path`, any synonym                | closed object         | Not a case/punctuation variant; suggested in error |
| `filePath` beside `file_path`, different value     | `file_path`           | Either could be meant                              |
| an unknown field, even with `null`                 | closed object         | Might carry intent                                 |
| anything under other `anyOf` / `oneOf` / `allOf`   | union                 | Several readings                                   |

Unknown fields are only handled this way when the schema says `additionalProperties: false`;
otherwise JSON Schema allows them and they pass through.

## Tool names

A name that differs from exactly one tool only in letter case or punctuation is corrected
(`bash` → `Bash`, `todo_write` → `TodoWrite`), as is gpt-oss's `functions.` prefix. Anything else
(`read_file`, `ReadFile`) is an unknown tool: nothing runs and the error lists the available tools,
with a "Did you mean" hint when exactly one tool name contains, or nearly equals, what was written.

## Calls written as text

Only when the reply has no structured calls. Markup inside code fences or inline code is an
example, never a call. Values from tag formats stay strings and go through the coercions above.

| Format                                                                  | Who emits it                                   |
| ----------------------------------------------------------------------- | ---------------------------------------------- |
| `<tool_call><function=N><parameter=K>\nV\n</parameter></function>`      | Qwen3.6 / Qwen3.8 templates (and Qwen3-Coder)  |
| `<tool_call>N<arg_key>K</arg_key><arg_value>V</arg_value></tool_call>` | Laguna XS 2.1 template; GLM-style templates    |
| `…to=functions.N <\|constrain\|>json<\|message\|>{…}<\|call\|>`         | gpt-oss (harmony), also in the analysis channel |
| `<tool_call>{"name": N, "arguments": {…}}</tool_call>`                  | Hermes-style templates, Qwen2.5 / Qwen3 2504   |
| `<function=N>{…}</function>`                                            | Llama 3.x                                      |
| `[TOOL_CALLS][{…}]`, `[TOOL_CALLS]N[ARGS]{…}`                           | Mistral                                        |
| a ` ```json ` fence, or the whole reply, holding exactly `{name, arguments}` (or `parameters`/`input`) for a known tool | any model |

Sources: the `chat_template.jinja` of Qwen/Qwen3.8-27B, Qwen/Qwen3.6-35B-A3B and
poolside/Laguna-XS-2.1 on Hugging Face (read 2026-11-21); gpt-oss leaks as reported in the
LangChain forum ("Harmony Response Format sometimes outputted…") and lmstudio-js issue 493.

Qwen parameter values lose exactly the one newline the template adds at each end. A missing
`</parameter>` is accepted before the next parameter or the end of the function, never at the end
of the reply. A call whose markup runs to the end of a reply cut by the output limit is truncated;
an opener cut before any tool name is removed from the text and reported through `notice`.

## Schema lint

`lintToolSchema` follows llama.cpp's `grammars/README.md` and `common/json-schema-to-grammar.cpp`
at the pinned runtime commit `b1b770d90d94cad9e9ea5b993bdbc383a522fb28`.

| Code                                  | Severity | Flags                                                                  |
| ------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `root_not_object`                     | error    | top level is not `type: "object"`                                      |
| `required_not_declared`               | error    | a required field missing from a closed object's `properties`           |
| `prefix_items`                        | error    | `prefixItems` (broken in llama.cpp)                                    |
| `pattern_properties`                  | error    | `patternProperties` (unsupported: those keys can never be generated)   |
| `properties_with_union`               | error    | `properties` beside `anyOf`/`oneOf` (llama.cpp #7703)                  |
| `remote_ref`, `unresolved_ref`        | error    | `$ref` outside the schema, or to nothing                               |
| `invalid_pattern`                     | error    | a pattern that is not a valid regular expression                       |
| `nested_ref`                          | warning  | a `$ref` whose target uses `$ref` (llama.cpp #8073)                    |
| `unanchored_pattern`                  | warning  | pattern without `^…$`: the grammar accepts any string                  |
| `unsupported_pattern`                 | warning  | `(?=`, `(?!`, named groups, backreferences, `\b`, inner anchors        |
| `unsupported_keyword`                 | warning  | `uniqueItems`, `contains`, `not`, `if`/`then`/`else`, `dependent*`, `multipleOf`, `propertyNames`, `min/maxProperties`, … (not enforced) |
| `unsupported_format`                  | warning  | formats other than `date`, `time`, `date-time`, `uuid`                 |
| `number_bounds`                       | warning  | `minimum`/`maximum` on `number` (only enforced for `integer`)          |
| `large_repetition`                    | warning  | `minLength`/`maxLength`/`minItems`/`maxItems` above 100 (slow sampling) |
| `missing_additional_properties_false` | warning  | an object schema without `additionalProperties: false`                 |
| `additional_properties_allowed`       | warning  | `additionalProperties` true or a schema                                |
| `missing_tool_description`, `missing_description` | warning | no tool description; a top-level field without one        |
| `untyped_property`                    | warning  | a field with no type, enum, const, ref or union                        |
| `deep_nesting`                        | warning  | object/array nesting deeper than 4 levels                              |
