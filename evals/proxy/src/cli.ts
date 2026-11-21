#!/usr/bin/env node
/**
 * Recording proxy CLI.
 *
 *   node evals/proxy/src/cli.ts --upstream <base URL ending in /v1> --port <n> --record <path.jsonl>
 *     [--upstream-key-env <ENV NAME>] [--bodies-dir <dir>] [--label <string>]
 *     [--no-inject-usage] [--upstream-model <name>] [--timeout-ms <n>] [--quiet]
 *
 * Prints exactly one line to stdout when ready: {"event":"listening","port":<n>}.
 * Everything else goes to stderr. SIGTERM / SIGINT: stop accepting, finish records, exit 0.
 */

import { parseArgs } from "node:util";
import { type RunningProxy, startProxy } from "./proxy.ts";

const HELP = `dawg eval proxy: records every model request between an agent and an OpenAI-compatible
endpoint, and translates Anthropic Messages requests to Chat Completions.

Usage:
  node evals/proxy/src/cli.ts --upstream <url> --record <file.jsonl> [options]

Required:
  --upstream <url>           Upstream base URL ending in /v1 (e.g. http://127.0.0.1:8080/v1)
  --record <path>            JSONL file to append one record per request to

Options:
  --port <n>                 Port on 127.0.0.1 (default 0 = pick a free port)
  --upstream-key-env <NAME>  Send "Authorization: Bearer $NAME" upstream instead of the
                             client's credentials (Authorization / x-api-key / api-key)
  --bodies-dir <dir>         Save full request and response bodies per seq (credentials stripped)
  --label <string>           Copied into every record
  --no-inject-usage          Do not add stream_options.include_usage=true to streamed chat
                             requests. By default the proxy adds it when missing so token usage
                             can be recorded; the extra final usage chunk (empty "choices") is
                             passed through to the client. This is the only change made to an
                             OpenAI-format request body.
  --upstream-model <name>    Anthropic-format requests only: model name to send upstream
                             instead of the one the client asked for
  --timeout-ms <n>           Abort an upstream request after n ms without data
                             (default 600000; 0 = never)
  --quiet                    No per-request log lines on stderr
  --help                     Show this help

Clients:
  OpenAI format:     base URL http://127.0.0.1:<port>/v1
  Anthropic format:  base URL http://127.0.0.1:<port>  (POST /v1/messages is translated)
`;

function fail(message: string, code = 2): never {
  process.stderr.write(`eval-proxy: ${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  let values: ReturnType<typeof parse>["values"];
  try {
    values = parse().values;
  } catch (err) {
    fail(`${err instanceof Error ? err.message : String(err)}\n\n${HELP}`);
  }
  if (values.help) {
    process.stderr.write(HELP);
    process.exit(0);
  }
  if (!values.upstream) fail(`--upstream is required\n\n${HELP}`);
  if (!values.record) fail(`--record is required\n\n${HELP}`);
  const port = parseInteger(values.port ?? "0", "--port");
  if (port < 0 || port > 65535) fail("--port must be between 0 and 65535");
  const timeoutMs =
    values["timeout-ms"] === undefined
      ? undefined
      : parseInteger(values["timeout-ms"], "--timeout-ms");

  const quiet = values.quiet === true;
  let proxy: RunningProxy;
  try {
    proxy = await startProxy({
      upstream: values.upstream,
      port,
      recordPath: values.record,
      upstreamKeyEnv: values["upstream-key-env"] ?? null,
      bodiesDir: values["bodies-dir"] ?? null,
      label: values.label ?? null,
      injectUsage: values["no-inject-usage"] !== true,
      upstreamModel: values["upstream-model"] ?? null,
      idleTimeoutMs: timeoutMs,
      log: quiet ? () => {} : (line) => process.stderr.write(`${line}\n`),
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), 1);
  }

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    if (!quiet) process.stderr.write(`[eval-proxy] ${signal}: shutting down\n`);
    // Hard deadline in case something hangs; records already queued are flushed by close().
    setTimeout(() => {
      process.stderr.write("[eval-proxy] shutdown timed out; exiting\n");
      process.exit(0);
    }, 15_000).unref();
    proxy.close().then(
      () => process.exit(0),
      (err: unknown) => {
        process.stderr.write(`[eval-proxy] error during shutdown: ${String(err)}\n`);
        process.exit(0);
      },
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  // A bug in one request must not take the whole eval run down.
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[eval-proxy] uncaught exception: ${err.stack ?? String(err)}\n`);
  });
  process.on("unhandledRejection", (err) => {
    process.stderr.write(`[eval-proxy] unhandled rejection: ${String(err)}\n`);
  });

  process.stdout.write(`${JSON.stringify({ event: "listening", port: proxy.port })}\n`);
}

function parse() {
  return parseArgs({
    args: process.argv.slice(2),
    strict: true,
    allowPositionals: false,
    options: {
      upstream: { type: "string" },
      port: { type: "string" },
      record: { type: "string" },
      "upstream-key-env": { type: "string" },
      "bodies-dir": { type: "string" },
      label: { type: "string" },
      "no-inject-usage": { type: "boolean" },
      "upstream-model": { type: "string" },
      "timeout-ms": { type: "string" },
      quiet: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
}

function parseInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) fail(`${flag} must be a non-negative integer`);
  return Number.parseInt(value, 10);
}

await main();
