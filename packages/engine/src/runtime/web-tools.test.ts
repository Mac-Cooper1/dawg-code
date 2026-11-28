/**
 * The web tools inside a whole engine: WebSearch offered only while a search service is
 * configured, WebFetch asking with the host in the card, and WebFetch handing a long page to the
 * session's utility model (a side request the scripted model answers in its own lane).
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import { text, toolCall } from "@dawg/mock-model";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SearchProvider } from "../contracts/web.ts";
import { CORE_TOOLS, createWebFetchTool, type Transport, webSearchTool } from "../tools/index.ts";
import { INTERACTIVE_TOOLS } from "../tools/interactive/index.ts";
import { type Harness, startHarness, textOf } from "./__fixtures__/harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

let server: Server;
let port = 0;
const LONG = Array.from({ length: 1_500 }, (_, i) => `Line ${i} of the changelog.`).join("\n");

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": req.url === "/long" ? "text/plain" : "text/html" });
    res.end(req.url === "/long" ? LONG : "<h1>Short page</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** Delivers to the local server; the resolver below answers a public address for every name. */
const transport: Transport = (request) =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: request.url.pathname, signal: request.signal },
      (res) =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: res,
          destroy: () => res.destroy(),
        }),
    );
    req.on("error", reject);
    req.end();
  });

const webFetch = createWebFetchTool({
  resolve: async () => [{ address: "93.184.215.14", family: 4 }],
  transport,
});

const search: SearchProvider = {
  id: "test",
  label: "Test Search",
  search: async () => [{ title: "Result", url: "https://example.com/r", snippet: "Snippet" }],
};

const tools = [...CORE_TOOLS, ...INTERACTIVE_TOOLS, webFetch, webSearchTool];
const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

describe("which web tools a session is offered", () => {
  it("offers WebSearch only to sessions opened while a search service is configured", async () => {
    let provider: SearchProvider | null = null;
    h = await startHarness({ engine: { tools, webSearch: () => provider } });
    const without = await h.engine.createSession({ cwd: h.project });
    expect(without.prefix.tools.map((t) => t.name)).toContain("WebFetch");
    expect(without.prefix.tools.map((t) => t.name)).not.toContain("WebSearch");
    provider = search;
    const withIt = await h.engine.createSession({ cwd: h.project });
    expect(withIt.prefix.tools.map((t) => t.name)).toContain("WebSearch");
    // The first session's prefix does not change mid-session.
    expect(without.prefix.tools.map((t) => t.name)).not.toContain("WebSearch");
  });

  it("includes both web tools in the default tool set", async () => {
    h = await startHarness({ engine: { webSearch: () => search } });
    const session = await h.engine.createSession({ cwd: h.project });
    const names = session.prefix.tools.map((t) => t.name);
    expect(names.slice(-2)).toEqual(["WebFetch", "WebSearch"]);
  });
});

describe("WebFetch in a turn", () => {
  it("asks first, naming the host and carrying the URL", async () => {
    h = await startHarness({
      engine: { tools },
      script: [
        toolCall("WebFetch", { url: "https://docs.example.com/page", prompt: "What is it?" }),
        text("ok"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.prompt(ask("read the page"));
    const requested = await h.waitFor((e) => e.event === "permission.requested");
    const request = requested.payload.request as {
      title: string;
      reason: string;
      suggestions: string[];
      input: { url: string };
      requestId: string;
    };
    expect(request.title).toBe("Fetch a page from docs.example.com");
    expect(request.reason).toBe("No rule allows fetching from docs.example.com.");
    expect(request.suggestions).toEqual(["WebFetch(domain:docs.example.com)"]);
    expect(request.input.url).toBe("https://docs.example.com/page");
    session.respondPermission(request.requestId, { behavior: "allow", scope: "once" });
    await session.waitForIdle();
    const result = session.view.find((m) => m.role === "tool" && m.toolName === "WebFetch");
    expect(textOf(result as never)).toContain("# Short page");
  });

  it("has the utility model answer about a long page, apart from the conversation", async () => {
    h = await startHarness({
      engine: { tools },
      script: {
        replies: [
          toolCall("WebFetch", {
            url: "https://docs.example.com/long",
            prompt: "What is the last line?",
          }),
          text("The last line is 1499."),
        ],
        lanes: {
          utility: {
            match: { system: "You read one web page" },
            replies: [text("The last line shown is Line 1499 of the changelog.")],
          },
        },
      },
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "bypassPermissions" });
    await session.run(ask("check the changelog"));
    const result = session.view.find((m) => m.role === "tool" && m.toolName === "WebFetch");
    const resultText = textOf(result as never);
    expect(resultText).toContain("A separate model read it");
    expect(resultText).toContain("The last line shown is Line 1499 of the changelog.");
    expect(resultText).not.toContain("Line 0 of the changelog.");
    const side = h.mock.requests.find((r) => r.lane === "utility");
    expect(side?.rawBody).toContain("Request: What is the last line?");
    expect(side?.rawBody).not.toContain('"tools"');
    // The side request is not part of the conversation's history.
    expect(
      session.view.some(
        (m) => m.role === "user" && textOf(m as never).includes("You read one web page"),
      ),
    ).toBe(false);
    const finished = h
      .ofType(session.id, "tool.finished")
      .find((e) => e.payload.toolName === "WebFetch");
    expect(finished?.payload.display).toMatchObject({ kind: "web-fetch", answeredBy: "model" });
  });
});
