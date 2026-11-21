// A tiny stand-in for evals/proxy that honours the same launch and record contract.
// It does not forward anything: every chat request gets a canned reply.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    upstream: { type: "string" },
    port: { type: "string" },
    record: { type: "string" },
    "upstream-key-env": { type: "string" },
    "bodies-dir": { type: "string" },
    label: { type: "string" },
  },
});
if (!values.upstream?.endsWith("/v1") || !values.record) {
  console.error("usage: fake-proxy --upstream <url>/v1 --port <n> --record <file>");
  process.exit(2);
}

let seq = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", () => {
    const started = new Date().toISOString();
    const parsed = body ? JSON.parse(body) : {};
    const n = ++seq;
    const isChat = req.url === "/v1/chat/completions";
    const record = {
      seq: n,
      started_at: started,
      duration_ms: 5,
      api: isChat ? "openai.chat" : "other",
      path: req.url,
      model: parsed.model ?? null,
      stream: false,
      status: 200,
      request: { messages: parsed.messages?.length ?? 0, tools: 0, body_bytes: body.length },
      usage: isChat ? { prompt_tokens: 100 * n, completion_tokens: 10, cached_tokens: null } : null,
      timings: isChat ? { cache_n: n === 1 ? 0 : 90, prompt_n: n === 1 ? 100 : 10 } : null,
      tool_calls: isChat ? [{ name: "Edit", arguments_valid_json: n !== 2, schema_valid: null, error: null }] : [],
      finish_reason: "stop",
      error: null,
      // Extra fields the runner must tolerate, plus what the fake saw (for assertions).
      fake: {
        label: values.label ?? null,
        key_env: values["upstream-key-env"] ?? null,
        client_auth: req.headers.authorization ?? null,
      },
    };
    appendFileSync(values.record, `${JSON.stringify(record)}\n`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
  });
});

server.listen(Number(values.port ?? 0), "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "listening", port: server.address().port }));
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
