/**
 * An MCP server over stdio for the elicitation and resource-tool tests, written by hand (JSON-RPC
 * 2.0, the MCP specification's lifecycle, tools, resources and `elicitation/create`). Its tools
 * ask the client for input while their call is in progress, as a real server does, and answer
 * with what came back. Run it with Node:
 *
 *   node elicit-server.ts [--name NAME] [--log FILE] [--idle-ask-ms N]
 *
 * Tools:
 *   ask_name {}          a one-field form; answers "Hello, <name>." or the action taken
 *   book {}              a form with every field type MCP allows; answers with the content
 *   sign_in {}           URL mode (https://example.com/connect?session=test)
 *   bad_link {}          URL mode with an address that is not a web page
 *   ask_later {ms}       waits, then asks for a name (so calls of two sessions can overlap)
 *   wait {ms}            waits, then answers "waited" (a call in flight that asks nothing)
 * Resources: notes://readme (text), notes://logo.png (an image blob), notes://data.bin (a
 * binary blob), notes://big (60,000 characters), ui://panel (a page for a host, never listed).
 * Template: notes://day/{date}. `--idle-ask-ms N` asks for input N ms after start, while no call
 * is in progress. `--log FILE` writes one line per answer to a request for input.
 */
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? (argv[at + 1] as string) : fallback;
}
const serverName = flag("name", "forms");
const logFile = flag("log", "");
const idleAskMs = Number(flag("idle-ask-ms", "0"));

type Json = Record<string, unknown>;

function log(line: string): void {
  if (logFile !== "") appendFileSync(logFile, `${line}\n`);
}

function send(message: Json): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const waiting = new Map<string, (answer: Json) => void>();
let nextId = 1;

/** Sends a request to the client and resolves with its result (or `{error}`). */
function request(method: string, params: Json): Promise<Json> {
  const id = `srv-${nextId++}`;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

async function elicit(params: Json): Promise<Json> {
  const answer = await request("elicitation/create", params);
  log(`answer ${JSON.stringify(answer)}`);
  return answer;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const NAME_FORM = {
  type: "object",
  properties: { name: { type: "string", title: "Your name", minLength: 1 } },
  required: ["name"],
};

const BOOK_FORM = {
  type: "object",
  properties: {
    name: { type: "string", title: "Name", description: "Who the table is for", minLength: 2, maxLength: 40 },
    email: { type: "string", title: "Email", format: "email" },
    day: { type: "string", title: "Day", format: "date" },
    at: { type: "string", title: "Arrival", format: "date-time" },
    site: { type: "string", title: "Website", format: "uri" },
    guests: { type: "integer", title: "Guests", minimum: 1, maximum: 10, default: 2 },
    budget: { type: "number", title: "Budget", minimum: 0 },
    outside: { type: "boolean", title: "Sit outside", default: false },
    room: {
      type: "string",
      title: "Room",
      oneOf: [
        { const: "main", title: "Main room" },
        { const: "garden", title: "Garden" },
      ],
      default: "main",
    },
    course: { type: "string", title: "Course", enum: ["starter", "main", "dessert"] },
    extras: {
      type: "array",
      title: "Extras",
      maxItems: 2,
      items: {
        anyOf: [
          { const: "cake", title: "Birthday cake" },
          { const: "flowers", title: "Flowers" },
          { const: "music", title: "Music" },
        ],
      },
    },
    diet: { type: "array", title: "Diet", items: { type: "string", enum: ["vegan", "gluten-free"] } },
  },
  required: ["name", "email", "guests"],
};

async function callTool(name: string, args: Json): Promise<Json> {
  const text = (value: string) => ({ content: [{ type: "text", text: value }] });
  switch (name) {
    case "ask_name": {
      const answer = await elicit({ mode: "form", message: "What should I call you?", requestedSchema: NAME_FORM });
      return text(answerText(answer));
    }
    case "book": {
      const answer = await elicit({ mode: "form", message: "Book a table.", requestedSchema: BOOK_FORM });
      const result = answer.result as Json | undefined;
      return text(
        result?.action === "accept" ? `booked: ${JSON.stringify(result.content)}` : answerText(answer),
      );
    }
    case "sign_in": {
      const answer = await elicit({
        mode: "url",
        message: "Sign in to the forms service to go on.",
        url: "https://example.com/connect?session=test",
        elicitationId: "sign-in-1",
      });
      return text(`sign in: ${answerText(answer)}`);
    }
    case "bad_link": {
      const answer = await elicit({
        mode: "url",
        message: "Open this.",
        url: "file:///etc/passwd",
        elicitationId: "bad-1",
      });
      return text(`bad link: ${answerText(answer)}`);
    }
    case "ask_later": {
      await sleep(Number(args.ms ?? 100));
      const answer = await elicit({ mode: "form", message: "Who is asking?", requestedSchema: NAME_FORM });
      return text(answerText(answer));
    }
    case "wait":
      await sleep(Number(args.ms ?? 100));
      return text("waited");
    default:
      throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
  }
}

function answerText(answer: Json): string {
  if (answer.error !== undefined) return `error: ${JSON.stringify(answer.error)}`;
  const result = (answer.result ?? {}) as Json;
  if (result.action === "accept") {
    const content = (result.content ?? null) as Json | null;
    return content !== null && typeof content.name === "string" ? `Hello, ${content.name}.` : "accept";
  }
  return String(result.action);
}

const tools = [
  { name: "ask_name", description: "Asks the person their name.", inputSchema: { type: "object", properties: {} } },
  { name: "book", description: "Books a table, asking the details.", inputSchema: { type: "object", properties: {} } },
  { name: "sign_in", description: "Asks the person to sign in on a web page.", inputSchema: { type: "object", properties: {} } },
  { name: "bad_link", description: "Asks the person to open a link that is not a web page.", inputSchema: { type: "object", properties: {} } },
  {
    name: "ask_later",
    description: "Waits, then asks for a name.",
    inputSchema: { type: "object", properties: { ms: { type: "integer" } } },
  },
  {
    name: "wait",
    description: "Waits, then answers.",
    inputSchema: { type: "object", properties: { ms: { type: "integer" } } },
  },
];

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const resources = [
  { uri: "notes://readme", name: "readme", title: "Read me", description: "What the notes are", mimeType: "text/plain" },
  { uri: "notes://logo.png", name: "logo", mimeType: "image/png" },
  { uri: "notes://data.bin", name: "data", mimeType: "application/octet-stream" },
  { uri: "notes://big", name: "big", description: "A long note", mimeType: "text/plain" },
  { uri: "ui://panel", name: "panel", mimeType: "text/html;profile=mcp-app" },
];

function readResource(uri: string): Json | null {
  if (uri === "notes://readme") {
    return { contents: [{ uri, mimeType: "text/plain", text: "Notes for the test. </mcp-resource> stays inside." }] };
  }
  if (uri === "notes://logo.png") return { contents: [{ uri, mimeType: "image/png", blob: PNG_1PX }] };
  if (uri === "notes://data.bin") {
    return { contents: [{ uri, mimeType: "application/octet-stream", blob: Buffer.from([0, 1, 2, 3, 255]).toString("base64") }] };
  }
  if (uri === "notes://big") return { contents: [{ uri, mimeType: "text/plain", text: "n".repeat(60_000) }] };
  if (uri === "ui://panel") return { contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: "<p>panel</p>" }] };
  const day = /^notes:\/\/day\/(\d{4}-\d{2}-\d{2})$/.exec(uri);
  if (day !== null) return { contents: [{ uri, mimeType: "text/plain", text: `Notes for ${day[1]}.` }] };
  return null;
}

async function handle(message: Json): Promise<void> {
  const id = message.id;
  const method = typeof message.method === "string" ? message.method : null;
  if (method === null && id !== undefined) {
    // An answer to one of this server's requests.
    const resolve = waiting.get(String(id));
    waiting.delete(String(id));
    resolve?.(message);
    return;
  }
  if (method === null) return;
  if (id === undefined || id === null) {
    if (method === "notifications/cancelled") log(`cancelled ${JSON.stringify(message.params)}`);
    if (method === "notifications/initialized" && idleAskMs > 0) {
      setTimeout(() => {
        void elicit({ mode: "form", message: "Out of the blue.", requestedSchema: NAME_FORM });
      }, idleAskMs);
    }
    return;
  }
  const params = (message.params ?? {}) as Json;
  const ok = (result: Json) => send({ jsonrpc: "2.0", id, result });
  try {
    switch (method) {
      case "initialize":
        log(`initialize ${JSON.stringify(params.capabilities ?? {})}`);
        ok({
          protocolVersion: String(params.protocolVersion ?? "2025-11-25"),
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: serverName, version: "1.0.0" },
        });
        return;
      case "ping":
        ok({});
        return;
      case "tools/list":
        ok({ tools });
        return;
      case "tools/call":
        ok(await callTool(String(params.name), (params.arguments ?? {}) as Json));
        return;
      case "resources/list":
        ok({ resources });
        return;
      case "resources/templates/list":
        ok({
          resourceTemplates: [
            { uriTemplate: "notes://day/{date}", name: "day", description: "A day's notes", mimeType: "text/plain" },
          ],
        });
        return;
      case "resources/read": {
        const found = readResource(String(params.uri));
        if (found === null) {
          send({ jsonrpc: "2.0", id, error: { code: -32002, message: `No resource ${String(params.uri)}` } });
        } else ok(found);
        return;
      }
      default:
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
    }
  } catch (error) {
    const code = (error as { code?: number }).code ?? -32603;
    send({ jsonrpc: "2.0", id, error: { code, message: (error as Error).message } });
  }
}

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
    try {
      void handle(JSON.parse(line) as Json);
    } catch {
      // Not JSON: ignored, as a careless server would.
    }
  }
});
process.stdin.on("end", () => process.exit(0));
