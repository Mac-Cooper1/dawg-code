/**
 * A small MCP server for tests, written by hand on node:http and stdio (JSON-RPC 2.0, the MCP
 * specification's lifecycle, tools, resources and prompts). Run it with Node:
 *
 *   node test-server.ts [--transport stdio|http|sse] [--port 0] [--name test]
 *                       [--tools N] [--crash-on crash] [--exit-after-ms N] [--auth TOKEN]
 *                       [--instructions TEXT] [--log FILE]
 *
 * Over HTTP it prints `{"url": "..."}` on one line once it listens. Tools:
 *   echo {text}         returns the text
 *   add {a, b}          returns a + b
 *   big {chars}         returns that many characters
 *   fail {}             a result with isError
 *   picture {}          an image and a text
 *   crash {}            exits the process (with --crash-on crash), as a crashing server does
 *   pad_<n> {...}       with --tools N: N tools with long schemas, to fill a prompt
 * Resources: docs://readme (text), docs://data.json (JSON). Prompts: review {target, focus?}.
 */
import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const argv = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? (argv[at + 1] as string) : fallback;
}
const transport = flag("transport", "stdio");
const serverName = flag("name", "test");
const padTools = Number(flag("tools", "0"));
const crashOn = flag("crash-on", "");
const exitAfterMs = Number(flag("exit-after-ms", "0"));
const authToken = flag("auth", "");
const instructions = flag("instructions", `Use the ${serverName} server's tools for tests.`);
const logFile = flag("log", "");

function log(line: string): void {
  if (logFile !== "") appendFileSync(logFile, `${line}\n`);
}
log(`start ${transport} pid=${process.pid} env.TEST_SECRET=${process.env.TEST_SECRET ?? ""} cwd=${process.cwd()}`);

if (exitAfterMs > 0) setTimeout(() => process.exit(3), exitAfterMs);

type Json = Record<string, unknown>;

const tools: Json[] = [
  {
    name: "echo",
    description: "Echoes the text back.\nA second line the listing leaves out.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "What to echo" } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add",
    description: "Adds two numbers.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
  {
    name: "big",
    description: "Returns a long text.",
    inputSchema: { type: "object", properties: { chars: { type: "integer" } }, required: ["chars"] },
  },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
  {
    name: "picture",
    description: "Returns a picture.",
    inputSchema: { type: "object", properties: {} },
  },
  { name: "crash", description: "Stops the server.", inputSchema: { type: "object" } },
];
for (let i = 0; i < padTools; i++) {
  const properties: Json = {};
  for (let p = 0; p < 12; p++) {
    properties[`field_${p}`] = {
      type: "string",
      description: `Field ${p} of padding tool ${i}, described at length so that the schema takes room in a prompt.`,
    };
  }
  tools.push({
    name: `pad_${String(i).padStart(3, "0")}`,
    description: `Padding tool number ${i}, which does nothing useful.`,
    inputSchema: { type: "object", properties },
  });
}

const resources = [
  { uri: "docs://readme", name: "readme", title: "Read me", description: "What the project is", mimeType: "text/plain" },
  { uri: "docs://data.json", name: "data", mimeType: "application/json" },
];

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function text(value: string, isError = false): Json {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

function callTool(name: string, args: Json): Json {
  log(`call ${name} ${JSON.stringify(args)}`);
  switch (name) {
    case "echo":
      return text(`echo: ${String(args.text)}`);
    case "add":
      return text(String(Number(args.a) + Number(args.b)));
    case "big":
      return text("x".repeat(Number(args.chars)));
    case "fail":
      return text("It did not work.", true);
    case "picture":
      return {
        content: [
          { type: "text", text: "A picture:" },
          { type: "image", data: PNG_1PX, mimeType: "image/png" },
        ],
      };
    case "crash":
      if (crashOn === "crash") {
        log("crashing");
        process.exit(1);
      }
      return text("Not crashing.");
    default:
      if (name.startsWith("pad_")) return text(`${name} ran`);
      throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
  }
}

/** Answers one JSON-RPC message; null for a notification. */
function handle(message: Json): Json | null {
  const id = message.id;
  const method = String(message.method ?? "");
  const params = (message.params ?? {}) as Json;
  if (id === undefined || id === null) return null; // A notification.
  const ok = (result: Json) => ({ jsonrpc: "2.0", id, result });
  try {
    switch (method) {
      case "initialize":
        return ok({
          protocolVersion: String(params.protocolVersion ?? "2025-06-18"),
          capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
          serverInfo: { name: serverName, version: "1.0.0" },
          instructions,
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools });
      case "tools/call":
        return ok(callTool(String(params.name), (params.arguments ?? {}) as Json));
      case "resources/list":
        return ok({ resources });
      case "resources/templates/list":
        return ok({ resourceTemplates: [] });
      case "resources/read": {
        const uri = String(params.uri);
        if (uri === "docs://readme") {
          return ok({ contents: [{ uri, mimeType: "text/plain", text: "The test project." }] });
        }
        if (uri === "docs://data.json") {
          return ok({ contents: [{ uri, mimeType: "application/json", text: '{"answer":42}' }] });
        }
        return { jsonrpc: "2.0", id, error: { code: -32002, message: `No resource ${uri}` } };
      }
      case "prompts/list":
        return ok({
          prompts: [
            {
              name: "review",
              description: "Review something carefully",
              arguments: [
                { name: "target", description: "What to review", required: true },
                { name: "focus", description: "What to look at" },
              ],
            },
          ],
        });
      case "prompts/get": {
        const args = (params.arguments ?? {}) as Json;
        if (params.name !== "review") {
          return { jsonrpc: "2.0", id, error: { code: -32602, message: "No such prompt" } };
        }
        const focus = args.focus === undefined ? "" : `, looking at ${String(args.focus)}`;
        return ok({
          description: "Review something carefully",
          messages: [
            { role: "user", content: { type: "text", text: `Review ${String(args.target)}${focus}.` } },
          ],
        });
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } };
    }
  } catch (error) {
    const code = (error as { code?: number }).code ?? -32603;
    return { jsonrpc: "2.0", id, error: { code, message: (error as Error).message } };
  }
}

function handleBody(body: unknown): Json | Json[] | null {
  if (Array.isArray(body)) {
    const out = body.map((m) => handle(m as Json)).filter((m): m is Json => m !== null);
    return out.length === 0 ? null : out;
  }
  return handle(body as Json);
}

// --- stdio -------------------------------------------------------------------------------------

if (transport === "stdio") {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at < 0) break;
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const answer = handleBody(message);
      if (answer !== null) process.stdout.write(`${JSON.stringify(answer)}\n`);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

// --- HTTP: streamable HTTP, and the older HTTP+SSE ---------------------------------------------

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data === "" ? null : JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function authorized(req: IncomingMessage, res: ServerResponse): boolean {
  if (authToken === "") return true;
  if (req.headers.authorization === `Bearer ${authToken}`) return true;
  res.writeHead(401, {
    "WWW-Authenticate": 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"',
  });
  res.end();
  return false;
}

if (transport === "http" || transport === "sse") {
  const sseStreams = new Map<string, ServerResponse>();
  let sessions = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    log(`${req.method} ${url.pathname} secret=${String(req.headers["x-test-secret"] ?? "")}`);
    if (!authorized(req, res)) return;
    if (transport === "http" && url.pathname === "/mcp") {
      if (req.method === "GET") {
        res.writeHead(405).end();
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      const body = await readBody(req).catch(() => undefined);
      if (body === undefined) {
        res.writeHead(400).end();
        return;
      }
      const answer = handleBody(body);
      const headers: Record<string, string> = {};
      if ((body as Json)?.method === "initialize") {
        sessions += 1;
        headers["mcp-session-id"] = `session-${sessions}`;
      }
      if (answer === null) {
        res.writeHead(202, headers).end();
        return;
      }
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify(answer));
      return;
    }
    if (transport === "sse" && url.pathname === "/sse" && req.method === "GET") {
      const id = `s${sseStreams.size + 1}`;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
      sseStreams.set(id, res);
      req.on("close", () => sseStreams.delete(id));
      return;
    }
    if (transport === "sse" && url.pathname === "/messages" && req.method === "POST") {
      const stream = sseStreams.get(url.searchParams.get("sessionId") ?? "");
      const body = await readBody(req).catch(() => undefined);
      if (stream === undefined || body === undefined) {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(202).end();
      const answer = handleBody(body);
      if (answer !== null) stream.write(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(Number(flag("port", "0")), "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const path = transport === "http" ? "/mcp" : "/sse";
    process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${port}${path}` })}\n`);
  });
}
