# @dawg/mock-model

A scripted OpenAI-compatible model server for deterministic tests and manual development. It
imitates the parts of llama-server (build b12359) that the engine relies on, closely enough that
the model client's code paths run unchanged: streamed and plain chat completions, `timings`,
progress chunks, the usage chunk, `/props`, the token-count endpoint, reasoning deltas, and the
error shapes. The shapes were taken from captured traffic of the real server, kept in
`src/__fixtures__/llama-server/`, and tests check the mock against them.

## Use from a test

```ts
import { startMockModel, text, toolCall } from "@dawg/mock-model";
import { createModelClient } from "../model/index.ts";

const mock = await startMockModel({
  script: [toolCall("Read", { file_path: "/tmp/a.txt" }), text("The file says hello.")],
});
const client = createModelClient(mock.endpoint);
// ... drive the engine ...
expect(mock.messages(1).at(-1)).toMatchObject({ role: "tool" });
mock.assertDone(); // fails if a scripted reply was not used, or a request found none
await mock.close();
```

`startMockModel(options)` listens on a random port on 127.0.0.1 and returns:

| Member                                 | What                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `url`, `baseUrl`, `port`               | Origin, the OpenAI root (`${url}/v1`), the port                            |
| `endpoint`                             | A ready `Endpoint` (kind `"bundled"` unless `kind` says otherwise)         |
| `requests`, `chatRequests`             | Every request received / chat requests only, in order                      |
| `messages(n)`                          | The `messages` of chat request `n` (negative counts from the end)          |
| `addReplies(...)`                      | Append replies to the main lane while running                              |
| `addLane(name, spec)`, `addLaneReplies` | Add a lane, or replies to one                                              |
| `pending()`, `unanswered`              | Replies left per lane; requests that found no reply                        |
| `openConnections`                      | Open sockets, for checking that a client closed its connection             |
| `setLoading(bool)`                     | `GET /health` answers 503 "Loading model" while true                       |
| `assertDone()`                         | Throws when replies are left over or a request went unanswered             |
| `close()`                              | Ends every connection, stalled streams included, and stops listening       |

Recorded requests hold `method`, `path`, `headers` (authorization headers removed), the parsed
`body`, the `rawBody`, and for chat requests the `lane` and `replyIndex` that answered.

### Options

| Option                                    | Default        | Meaning                                                                 |
| ----------------------------------------- | -------------- | ----------------------------------------------------------------------- |
| `script`                                  | none           | An array of replies, or `{ replies, lanes }`                            |
| `kind`                                    | `"bundled"`    | The `Endpoint.kind` reported                                            |
| `flavor`                                  | by kind        | `"llama.cpp"` (bundled) adds timings, progress, `/props`, token count; `"openai"` leaves them out |
| `model`                                   | `"mock-model"` | Model id                                                                |
| `contextWindow`                           | 8192           | Reported in `/props` and `/v1/models`                                   |
| `enforceContextWindow`                    | false          | Reject prompts whose estimate reaches the window, with the real error   |
| `totalSlots`, `templateCaps`, `chatTemplate` |             | What `/props` reports                                                   |
| `capabilities`                            | tools only     | `tools`, `vision`, `reasoning` on the endpoint (and `modalities.vision`) |
| `apiKey`                                  | none           | Require `Authorization: Bearer <key>` (not on `/health`)                |
| `countTokens`                             | characters / 4 | Token counter for usage and the token-count endpoint                    |
| `promptTokensPerSecond`, `completionTokensPerSecond` | 1000, 50 | Speeds used to make `timings`                                  |
| `progressBatch`                           | 512            | Prompt tokens per progress chunk                                        |

Prompt caching is simulated per slot (`id_slot`, default 0): `cached_tokens` and
`timings.cache_n` are the tokens of the longest common prefix with the slot's previous prompt,
less the last token, as on the real server. `cache_prompt: false` turns it off for a request.

## Script format

A script is JSON. Every builder function returns the same plain data, so scripts can live in
files.

```json
{
  "replies": [
    { "reasoning": "The user wants the file.", "toolCalls": [{ "name": "Read", "arguments": { "file_path": "a.txt" } }] },
    { "text": ["The file ", "says hello."], "usage": { "promptTokens": 1200, "cachedTokens": 1100 } }
  ],
  "lanes": {
    "title": { "match": { "system": "Write a short title" }, "replies": [{ "text": "Reading a file" }] }
  }
}
```

### Replies

| Field          | Meaning                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------- |
| `text`         | Visible text; an array of strings fixes the exact chunks                                      |
| `reasoning`    | Streamed first, as `reasoning_content`; string or chunk array                                 |
| `toolCalls`    | `[{ name, arguments?, id? }]`. `arguments` is an object (serialised), a string sent as is (so it can be invalid JSON), or an array of exact chunks. `id` defaults to `call_<request>_<n>`; `""` sends none |
| `finishReason` | Default `tool_calls` when there are calls, else `stop`                                        |
| `usage`        | `promptTokens`, `completionTokens`, `cachedTokens` overriding the estimates                   |
| `pacing`       | `chunkSize` (16), `argumentChunkSize` (8), `delayMs`, `firstEventDelayMs`, `toolCallStyle`     |
| `wire`         | `bytesPerWrite` (split events and characters on the wire), `lineEnding` (`"lf"` or `"crlf"`), `comments` (a `: keep-alive` line before each event) |
| `fault`        | See below                                                                                     |
| `label`        | Name used in `assertDone` reports                                                             |

`toolCallStyle`: `"split"` (llama-server's layout: the first delta carries index, id, type, name
and the first argument piece), `"whole"` (each call complete in one delta), `"no-index"`,
`"no-id"`.

### Faults

| `fault.type`        | Behaviour                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `drop`              | Destroy the socket after `afterEvents` events (default 2; 0 right after the headers). On a non-streaming request, close without answering |
| `stall`             | Send `afterEvents` events (default 2), then nothing, forever                                |
| `http`              | Answer `status` with `body` (default `{"error":{"code","message","type"}}`, `message` optional) |
| `context_overflow`  | HTTP 400 `exceed_context_size_error` with `n_prompt_tokens` and `n_ctx`, as llama-server    |
| `non_streaming`     | Answer a streaming request with a plain JSON chat completion                                |
| `stream_error`      | After `afterEvents` events, send llama-server's `data: {"error": {...}}` event and end without `[DONE]` |
| `invalid`           | HTTP 200 with something that is not a chat completion (`contentType`, `body`; an HTML page by default) |

Builders: `text`, `reasoning`, `toolCall`, `toolCalls`, `malformedToolCall`, `empty`,
`dropped`, `stalled`, `httpError`, `contextOverflow`, `nonStreaming`, `streamError`,
`invalidResponse`.

### Matching

Chat requests are answered in order. Lanes keep side requests (a title, a summary) from using the
main conversation's replies: a request goes to the first lane whose `match` fits, else to the
main lane (the `replies` list), and takes that lane's next reply. A lane that runs out does not
fall back to the main lane.

`match` is either a function of the recorded request (in code) or an object whose given fields
must all hold:

| Field             | Holds when                                     |
| ----------------- | ---------------------------------------------- |
| `system`          | The first system message contains this text     |
| `lastUser`        | The last user message contains this text        |
| `bodyIncludes`    | The raw body contains this text                 |
| `hasTools`        | The request does (true) or does not offer tools |
| `maxTokensAtMost` | `max_tokens` is set and at most this            |

A chat request with no reply left gets HTTP 500 with
`{"error": {"type": "mock_script_error", "message": "mock-model: no scripted reply left ..."}}`,
and `assertDone()` reports it.

## Endpoints

| Path                                     | Notes                                                    |
| ---------------------------------------- | -------------------------------------------------------- |
| `GET /health`, `/v1/health`              | No key needed                                            |
| `GET /v1/models`                         | llama-server's shape (with `meta.n_ctx`) or OpenAI's     |
| `GET /props`                             | llama.cpp flavour only; parses with `parseServerInfo`    |
| `POST /v1/chat/completions`              | Streaming and not                                        |
| `POST /v1/chat/completions/input_tokens` | llama.cpp flavour only: `{"input_tokens", "object"}`     |

Request fields honoured: `stream`, `stream_options.include_usage`, `return_progress`,
`timings_per_token`, `id_slot`, `cache_prompt`.

## Command line

```
node packages/mock-model/src/cli.ts --script <file.json> [--port <n|0>] [--kind <kind>]
    [--model <id>] [--context <tokens>] [--verbose]
```

Prints one line, `{"event":"listening","port":n,"baseUrl":"..."}`, then serves until SIGTERM or
SIGINT and exits 0. The file may add a `"server"` object with `kind`, `flavor`, `model`,
`contextWindow`, `enforceContextWindow`, `totalSlots`, `chatTemplate`, `templateCaps` and
`capabilities`. To require an API key, set `DAWG_MOCK_API_KEY`; keys never go in script files.
`--verbose` logs each request as a JSON line on stderr.
