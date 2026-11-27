/**
 * Side requests through a helper model, in a whole engine: the session's title and WebFetch's
 * page summary go to the helper (a fake client here), with its profile's template options, and
 * WebFetch sizes the page to the helper's window. When the helper cannot be reached they go to
 * the main model's side lane instead, as they did before there was a helper.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import { text, toolCall } from "@dawg/mock-model";
import type { Endpoint } from "@dawg/models";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type ModelClient, ModelError, type ModelRequest } from "../contracts/model.ts";
import { createModelClient } from "../model/client.ts";
import { sideClient } from "../model/side.ts";
import { getModelProfile } from "../profiles/index.ts";
import { CORE_TOOLS, createWebFetchTool, type Transport } from "../tools/index.ts";
import { fakeProfile } from "./__fixtures__/fakes.ts";
import { type Harness, startHarness, textOf } from "./__fixtures__/harness.ts";
import type { ModelConnection } from "./types.ts";

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
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(LONG);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

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

const HELPER_ENDPOINT: Endpoint = {
  kind: "bundled",
  baseUrl: "http://127.0.0.1:9/v1",
  model: "minicpm5-1b-q8",
  // A small window, so the page has to be cut to fit it.
  contextWindow: 8_000,
  capabilities: { tools: false, vision: false, reasoning: true, cacheControl: true },
};

/** The helper: answers titles and page questions, recording what it was sent. */
function fakeHelper(options: { down?: boolean } = {}) {
  const requests: ModelRequest[] = [];
  const client: ModelClient = {
    endpoint: HELPER_ENDPOINT,
    async *stream(request) {
      requests.push(request);
      if (options.down) throw new ModelError("connection", "connect ECONNREFUSED 127.0.0.1:9");
      const system = request.messages[0]?.role === "system" ? request.messages[0].content : "";
      const content = system.includes("short title")
        ? "Check the changelog"
        : "The page lists changelog lines from Line 0 on.";
      yield {
        type: "finished",
        reply: {
          content,
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            cachedTokens: 0,
            promptTokensPerSecond: null,
            completionTokensPerSecond: null,
            promptMs: null,
            completionMs: null,
          },
          model: "minicpm5-1b-q8",
        },
      };
    },
    countTokens: async () => null,
  };
  return { client, requests };
}

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const userText = (request: ModelRequest | undefined) =>
  request?.messages
    .filter((m) => m.role === "user")
    .map((m) => textOf(m as never))
    .join("\n") ?? "";

async function withHelper(helper: ReturnType<typeof fakeHelper>, fallbacks: string[]) {
  let connection: ModelConnection | null = null;
  h = await startHarness({
    engine: {
      tools: [...CORE_TOOLS, webFetch],
      generateTitles: true,
      models: { connect: async () => connection as ModelConnection },
      // The helper's profile turns thinking off; the main model keeps the test profile.
      profile: (endpoint) =>
        endpoint.model === HELPER_ENDPOINT.model ? getModelProfile("minicpm5") : fakeProfile,
    },
    script: {
      replies: [
        toolCall("WebFetch", { url: "https://docs.example.com/long", prompt: "What is it?" }),
        text("It is a changelog."),
      ],
      lanes: {
        title: { match: { system: "short title" }, replies: [text("Main model title")] },
        utility: {
          match: { system: "You read one web page" },
          replies: [text("The main model read the page.")],
        },
      },
    },
  });
  const main = createModelClient(h.mock.endpoint);
  connection = {
    client: main,
    utility: {
      client: sideClient({
        routes: async () => ({ helper: { client: helper.client }, main: { client: main } }),
        endpoint: () => helper.client.endpoint,
        onFallback: (problem) => fallbacks.push(problem),
      }),
    },
  };
  return h;
}

describe("the helper model answers side requests", () => {
  it("writes the title and reads the long page, with thinking off, sized to its window", async () => {
    const helper = fakeHelper();
    const fallbacks: string[] = [];
    const harness = await withHelper(helper, fallbacks);
    const session = await harness.engine.createSession({
      cwd: harness.project,
      mode: "bypassPermissions",
    });
    await session.run(ask("check the changelog"));
    await harness.waitFor(
      (e) => e.event === "session.updated" && (e.payload.changed as string[]).includes("title"),
    );
    expect(session.summary().title).toBe("Check the changelog");

    const title = helper.requests.find((r) =>
      r.messages[0]?.content.toString().includes("short title"),
    );
    const page = helper.requests.find((r) =>
      r.messages[0]?.content.toString().includes("You read one web page"),
    );
    expect(title).toBeDefined();
    expect(page).toBeDefined();
    for (const request of [title, page]) {
      expect(request?.extraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } });
      expect(request?.tools).toEqual([]);
    }
    // WebFetch cut the page to what the helper's 8,000-token window holds:
    // (8,000 - 2,048 for the answer - 1,024 spare) × 3 characters a token.
    const asked = userText(page);
    const pageText = asked.slice(asked.indexOf("<page>\n") + 7, asked.lastIndexOf("\n</page>"));
    expect(pageText.length).toBe((8_000 - 2_048 - 1_024) * 3);
    expect(pageText).toContain("Line 0 of the changelog.");
    expect(pageText).not.toContain("Line 1499 of the changelog.");

    const result = session.view.find((m) => m.role === "tool" && m.toolName === "WebFetch");
    expect(textOf(result as never)).toContain("The page lists changelog lines from Line 0 on.");
    // Nothing went to the main model's side lanes.
    expect(harness.mock.requests.filter((r) => r.lane === "utility" || r.lane === "title")).toEqual(
      [],
    );
    expect(fallbacks).toEqual([]);
  });

  it("falls back to the main model when the helper cannot be reached", async () => {
    const helper = fakeHelper({ down: true });
    const fallbacks: string[] = [];
    const harness = await withHelper(helper, fallbacks);
    const session = await harness.engine.createSession({
      cwd: harness.project,
      mode: "bypassPermissions",
    });
    await session.run(ask("check the changelog"));
    await harness.waitFor(
      (e) => e.event === "session.updated" && (e.payload.changed as string[]).includes("title"),
    );
    expect(session.summary().title).toBe("Main model title");
    const result = session.view.find((m) => m.role === "tool" && m.toolName === "WebFetch");
    expect(textOf(result as never)).toContain("The main model read the page.");
    expect(harness.mock.requests.some((r) => r.lane === "utility")).toBe(true);
    expect(fallbacks.length).toBe(2);
    expect(fallbacks[0]).toContain("ECONNREFUSED");
  });
});
