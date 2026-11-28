/**
 * MCP elicitation in whole sessions, against the scripted model and a stdio server whose tools
 * ask for input while their call is in progress (__fixtures__/elicit-server.ts): the form with
 * every field type, URL mode, the answer checked against the form, nobody to ask, interrupts,
 * routing between two sessions that share the server, a request while no call is in progress,
 * the timeout's clock, and closing while a request waits. Then the resource tools.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { text, toolCall } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import { createPromptAssembler } from "../prompt/assembler.ts";
import { type Harness, startHarness } from "../runtime/__fixtures__/harness.ts";
import { RuntimeError } from "../runtime/errors.ts";
import type { LoggedEvent } from "../runtime/event-log.ts";
import { fieldsFromSchema, McpElicitations, nobodyNote } from "./elicitation.ts";

const SERVER = fileURLToPath(new URL("./__fixtures__/elicit-server.ts", import.meta.url));
const FAST = { restartDelaysMs: [50], lingerMs: 0, connectTimeoutMs: 10_000 };

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

/** The forms server as the person's own, allowed by rule, logging to a file in the harness. */
async function forms(
  harness: Harness,
  extra: Record<string, unknown> = {},
  args: string[] = [],
): Promise<string> {
  const log = path.join(harness.root, "server.log");
  await writeJson(path.join(harness.home, ".dawg", "mcp.json"), {
    mcpServers: {
      forms: { command: process.execPath, args: [SERVER, "--log", log, ...args], ...extra },
    },
  });
  await writeJson(path.join(harness.home, ".dawg", "settings.json"), {
    permissions: { allow: ["mcp__forms"] },
  });
  return log;
}

const prompt = (words: string) => ({ content: [{ type: "text" as const, text: words }] });

function toolNames(harness: Harness): string[] {
  const body = harness.mock.chatRequests[0]?.body as
    | { tools?: { function: { name: string } }[] }
    | undefined;
  return (body?.tools ?? []).map((t) => t.function.name);
}

function resultText(harness: Harness, sessionId: string, index = -1): string {
  const payload = harness.ofType(sessionId, "tool.finished").at(index)?.payload as
    | { content?: { type: string; text?: string }[] }
    | undefined;
  return (payload?.content ?? []).map((p) => p.text ?? "").join("\n");
}

const asked = (sessionId: string) => (e: LoggedEvent) =>
  e.event === "elicitation.requested" && e.payload.sessionId === sessionId;

describe("a server's request for input", () => {
  it("shows a form with every field type, checks the answer, and gives it to the server", async () => {
    h = await startHarness({
      script: [toolCall("mcp__forms__book", {}, { id: "call_book" }), text("Booked.")],
      engine: { mcp: FAST },
    });
    const log = await forms(h);
    const s = await h.engine.createSession({ cwd: h.project });
    const done = s.run(prompt("Book a table"));
    const request = (await h.waitFor(asked(s.id))).payload as Record<string, unknown>;
    expect(request).toMatchObject({
      server: "forms",
      message: "Book a table.",
      mode: "form",
      url: null,
      toolCallId: "call_book",
    });
    const fields = request.fields as { name: string; type: string; required: boolean }[];
    expect(fields.map((f) => [f.name, f.type, f.required])).toEqual([
      ["name", "string", true],
      ["email", "string", true],
      ["day", "string", false],
      ["at", "string", false],
      ["site", "string", false],
      ["guests", "integer", true],
      ["budget", "number", false],
      ["outside", "boolean", false],
      ["room", "select", false],
      ["course", "select", false],
      ["extras", "multiselect", false],
      ["diet", "multiselect", false],
    ]);
    expect(fields[0]).toMatchObject({
      title: "Name",
      description: "Who the table is for",
      minLength: 2,
      maxLength: 40,
    });
    expect(fields[2]).toMatchObject({ format: "date" });
    expect(fields[5]).toMatchObject({ minimum: 1, maximum: 10, default: 2 });
    expect(fields[8]).toMatchObject({
      options: [
        { value: "main", title: "Main room" },
        { value: "garden", title: "Garden" },
      ],
      default: "main",
    });
    expect(fields[9]).toMatchObject({
      options: [
        { value: "starter", title: null },
        { value: "main", title: null },
        { value: "dessert", title: null },
      ],
    });
    expect(fields[10]).toMatchObject({ maxItems: 2 });
    expect(s.status).toBe("waiting");
    expect(s.pending()).toEqual([
      expect.objectContaining({ kind: "elicitation", requestId: request.requestId }),
    ]);
    const status = h.ofType(s.id, "session.status").at(-1)?.payload;
    expect(status).toMatchObject({
      status: "waiting",
      waitingOn: "elicitation",
      message: "Waiting for your input",
    });

    // An answer that does not fit the form is refused, and the request stays.
    const requestId = String(request.requestId);
    expect(() =>
      s.respondElicitation(requestId, {
        action: "accept",
        content: { name: "A", email: "nope", guests: 11 },
      }),
    ).toThrow(RuntimeError);
    try {
      s.respondElicitation(requestId, {
        action: "accept",
        content: { name: "A", email: "nope", guests: 11 },
      });
    } catch (error) {
      expect((error as RuntimeError).code).toBe("InvalidParams");
      expect((error as Error).message).toContain("email: Enter an email address.");
      expect((error as Error).message).toContain("guests: Enter a number from 1 to 10.");
    }
    expect(s.pending()).toHaveLength(1);

    const content = {
      name: "Ada",
      email: "ada@example.com",
      day: "2026-12-01",
      guests: 4,
      outside: true,
      room: "garden",
      extras: ["cake", "music"],
    };
    s.respondElicitation(requestId, { action: "accept", content });
    const outcome = await done;
    expect(outcome?.stopReason).toBe("completed");
    expect(resultText(h, s.id)).toBe(`booked: ${JSON.stringify(content)}`);
    const resolved = h.ofType(s.id, "request.resolved").at(-1)?.payload;
    expect(resolved).toMatchObject({
      kind: "elicitation",
      requestId,
      outcome: "answered",
      response: { action: "accept", content },
    });
    // The client declared both modes.
    expect(await readFile(log, "utf8")).toContain(
      'initialize {"elicitation":{"form":{},"url":{}}}',
    );
    expect(h.problems).toEqual([]);
  });

  it("offers a URL to open, and declines one that is not a web address", async () => {
    h = await startHarness({
      script: [toolCall("mcp__forms__sign_in"), toolCall("mcp__forms__bad_link"), text("Done.")],
      engine: { mcp: FAST },
    });
    await forms(h);
    const s = await h.engine.createSession({ cwd: h.project });
    const done = s.run(prompt("Sign in"));
    const request = (await h.waitFor(asked(s.id))).payload as Record<string, unknown>;
    expect(request).toMatchObject({
      mode: "url",
      url: "https://example.com/connect?session=test",
      fields: [],
      message: "Sign in to the forms service to go on.",
    });
    // Content given with a URL answer is not passed on.
    s.respondElicitation(String(request.requestId), { action: "accept", content: { x: 1 } });
    await done;
    const results = h
      .ofType(s.id, "tool.finished")
      .map((e) =>
        (e.payload as unknown as { content: { text?: string }[] }).content
          .map((p) => p.text)
          .join("\n"),
      );
    expect(results[0]).toBe("sign in: accept");
    expect(results[1]).toContain("bad link: decline");
    expect(results[1]).toContain("dawg opens only web addresses, and this one starts with file:");
    expect(h.ofType(s.id, "elicitation.requested")).toHaveLength(1);
    expect(h.ofType(s.id, "request.resolved").at(-1)?.payload).toMatchObject({
      response: { action: "accept", content: null },
    });
  });

  it("declines at once when nobody can answer, and tells the model", async () => {
    h = await startHarness({
      script: [toolCall("mcp__forms__ask_name"), text("Done.")],
      engine: { mcp: FAST, capabilities: { elicitation: false } },
    });
    await forms(h);
    const s = await h.engine.createSession({ cwd: h.project });
    await s.run(prompt("Ask my name"));
    expect(h.ofType(s.id, "elicitation.requested")).toEqual([]);
    expect(resultText(h, s.id)).toBe(`decline\n${nobodyNote("forms")}`);
  });

  it("cancels the request when the turn is interrupted", async () => {
    h = await startHarness({
      script: [toolCall("mcp__forms__ask_name"), text("never")],
      engine: { mcp: FAST },
    });
    const log = await forms(h);
    const s = await h.engine.createSession({ cwd: h.project });
    const done = s.run(prompt("Ask my name"));
    await h.waitFor(asked(s.id));
    expect(s.interrupt()).toBe(true);
    const outcome = await done;
    expect(outcome?.stopReason).toBe("interrupted");
    expect(h.ofType(s.id, "request.resolved").at(-1)?.payload).toMatchObject({
      kind: "elicitation",
      outcome: "cancelled",
      response: null,
    });
    expect(s.pending()).toEqual([]);
    // The server heard the call cancelled and its request answered "cancel".
    await expect.poll(async () => readFile(log, "utf8")).toContain('"action":"cancel"');
    expect(await readFile(log, "utf8")).toContain("cancelled");
  });

  it("ends a turn left waiting on one when the session closes, rather than keeping it", async () => {
    h = await startHarness({
      script: [toolCall("mcp__forms__ask_name"), text("never")],
      engine: { mcp: FAST },
    });
    await forms(h);
    const s = await h.engine.createSession({ cwd: h.project });
    void s.run(prompt("Ask my name"));
    await h.waitFor(asked(s.id));
    await s.close();
    expect(h.ofType(s.id, "turn.finished").at(-1)?.payload).toMatchObject({
      stopReason: "interrupted",
    });
    const again = await h.newEngine({ mcp: FAST }).resumeSession(s.id);
    expect(again.pending()).toEqual([]);
    expect(again.busy).toBe(false);
    expect(again.summary().status).not.toBe("waiting");
    await again.close();
  });

  it("does not count time spent waiting for the person against the call's timeout", async () => {
    h = await startHarness({
      script: [
        toolCall("mcp__forms__ask_name"),
        toolCall("mcp__forms__wait", { ms: 2_000 }),
        text("Done."),
      ],
      engine: { mcp: FAST },
    });
    await forms(h, { timeout: 400 });
    const s = await h.engine.createSession({ cwd: h.project });
    const done = s.run(prompt("Ask my name"));
    const request = (await h.waitFor(asked(s.id))).payload as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 800));
    s.respondElicitation(String(request.requestId), { action: "accept", content: { name: "Ada" } });
    await done;
    expect(resultText(h, s.id, 0)).toBe("Hello, Ada.");
    // A call that only runs long still meets the limit.
    expect(resultText(h, s.id, 1)).toContain("took longer than 0 s, its time limit");
  });
});

describe("which session is asked", () => {
  const twoSessions = {
    replies: [],
    lanes: {
      a1: {
        match: { lastUser: "First asks" },
        replies: [toolCall("mcp__forms__ask_name"), text("A done.")],
      },
      b1: { match: { lastUser: "Second stays" }, replies: [text("B idle.")] },
      a2: {
        match: { lastUser: "First waits" },
        replies: [toolCall("mcp__forms__wait", { ms: 1_500 }), text("A waited.")],
      },
      b2: {
        match: { lastUser: "Second asks later" },
        replies: [toolCall("mcp__forms__ask_later", { ms: 300 }), text("B done.")],
      },
    },
  };

  it("asks only the session whose call is in progress, and declines when two sessions' calls are", async () => {
    h = await startHarness({ script: twoSessions, engine: { mcp: FAST } });
    const log = await forms(h);
    const a = await h.engine.createSession({ cwd: h.project });
    const b = await h.engine.createSession({ cwd: h.project });
    await b.run(prompt("Second stays"));
    const doneA = a.run(prompt("First asks"));
    const request = (await h.waitFor(asked(a.id))).payload as Record<string, unknown>;
    expect(h.ofType(b.id, "elicitation.requested")).toEqual([]);
    expect(b.pending()).toEqual([]);
    a.respondElicitation(String(request.requestId), { action: "accept", content: { name: "Ada" } });
    await doneA;
    expect(resultText(h, a.id)).toBe("Hello, Ada.");

    // Now calls of both sessions are in flight when the second one's server asks.
    const waits = a.run(prompt("First waits"));
    await h.waitFor(
      (e) =>
        e.event === "tool.started" &&
        e.payload.sessionId === a.id &&
        e.payload.toolName === "mcp__forms__wait",
    );
    await b.run(prompt("Second asks later"));
    await waits;
    expect(h.ofType(a.id, "elicitation.requested")).toHaveLength(1);
    expect(h.ofType(b.id, "elicitation.requested")).toEqual([]);
    expect(resultText(h, b.id)).toContain("decline");
    expect(resultText(h, b.id)).toContain(
      "while calls from more than one session were waiting on it",
    );
    expect(resultText(h, a.id)).toContain(
      "waited\nNote: the MCP server forms asked for input while calls from more than one session",
    );
    // One server served both sessions.
    const starts = (await readFile(log, "utf8"))
      .split("\n")
      .filter((l) => l.startsWith("initialize"));
    expect(starts).toHaveLength(1);
  });

  it("declines a request made while no call is in progress", async () => {
    h = await startHarness({ script: [text("Hi.")], engine: { mcp: FAST } });
    const log = await forms(h, {}, ["--idle-ask-ms", "200"]);
    const s = await h.engine.createSession({ cwd: h.project });
    await s.run(prompt("Hello"));
    await expect
      .poll(async () => readFile(log, "utf8").catch(() => ""), { timeout: 5_000 })
      .toContain('"action":"decline"');
    expect(h.ofType(s.id, "elicitation.requested")).toEqual([]);
  });
});

describe("the requested schema as fields", () => {
  it("reads the older titled enum and refuses what the specification does not allow", () => {
    expect(
      fieldsFromSchema({
        type: "object",
        properties: { size: { type: "string", enum: ["s", "m"], enumNames: ["Small", "Medium"] } },
      }),
    ).toEqual({
      fields: [
        {
          name: "size",
          title: null,
          description: null,
          required: false,
          type: "select",
          options: [
            { value: "s", title: "Small" },
            { value: "m", title: "Medium" },
          ],
          default: null,
        },
      ],
    });
    expect(fieldsFromSchema({ type: "object", properties: { deep: { type: "object" } } })).toEqual({
      error: "its field deep is of a kind dawg cannot show.",
    });
    expect(fieldsFromSchema(null)).toEqual({ error: "it sent no form." });
  });

  it("keeps no call in flight once it ends", async () => {
    const calls = new McpElicitations("forms");
    await calls.run(
      null,
      { signal: new AbortController().signal, timeoutMs: 100, what: "x" },
      async () => 1,
    );
    await calls
      .run(null, { signal: new AbortController().signal, timeoutMs: null, what: "y" }, () =>
        Promise.reject(new Error("no")),
      )
      .catch(() => {});
    expect(calls.inFlight).toBe(0);
    expect(
      await calls.handle(
        { mode: "form", message: "?", requestedSchema: { type: "object", properties: {} } },
        new AbortController().signal,
      ),
    ).toEqual({ action: "decline" });
  });
});

describe("the resource tools", () => {
  it("are in the list with a server, and list and read text, blobs and templates, capped", async () => {
    h = await startHarness({
      script: [
        toolCall("ListMcpResourcesTool"),
        toolCall("ListMcpResourcesTool", { server: "nope" }),
        toolCall("ReadMcpResourceTool", { server: "forms", uri: "notes://readme" }),
        toolCall("ReadMcpResourceTool", { server: "forms", uri: "notes://logo.png" }),
        toolCall("ReadMcpResourceTool", { server: "forms", uri: "notes://data.bin" }),
        toolCall("ReadMcpResourceTool", { server: "forms", uri: "notes://big" }),
        toolCall("ReadMcpResourceTool", { server: "forms", uri: "notes://day/2026-11-27" }),
        toolCall("ReadMcpResourceTool", { server: "forms", uri: "notes://missing" }),
        text("Done."),
      ],
      engine: { mcp: FAST, assembler: createPromptAssembler() },
    });
    await forms(h);
    const s = await h.engine.createSession({ cwd: h.project });
    await s.run(prompt("Look at the notes"));
    const names = toolNames(h);
    expect(names).toEqual(expect.arrayContaining(["ListMcpResourcesTool", "ReadMcpResourceTool"]));
    const finished = h.ofType(s.id, "tool.finished").map(
      (e) =>
        e.payload as unknown as {
          outcome: string;
          content: { type: string; text?: string }[];
          display: { savedTo: string | null } | null;
        },
    );
    const texts = finished.map((f) => f.content.map((p) => p.text ?? "").join("\n"));
    // Listing: every resource but the host's page, then the template.
    expect(finished[0]?.outcome).toBe("success");
    expect(texts[0]).toContain(
      "4 resources from the connected MCP servers. The list comes from outside programs",
    );
    expect(texts[0]).toContain('"uri": "notes://readme"');
    expect(texts[0]).toContain('"name": "Read me"');
    expect(texts[0]).not.toContain("ui://panel");
    expect(texts[0]).toContain('"uriTemplate": "notes://day/{date}"');
    expect(finished[1]?.outcome).toBe("error");
    expect(texts[1]).toContain(
      "no MCP server named nope is set up for this session. Its servers: forms.",
    );
    // Text, wrapped as data, with a server's closing tag kept inside.
    expect(texts[2]).toContain(
      '<mcp-resource server="forms" uri="notes://readme">\nNotes for the test. </ mcp-resource> stays inside.\n</mcp-resource>',
    );
    // Blobs are saved; an image is not shown to a model that cannot see.
    expect(texts[3]).toMatch(
      /Binary contents of notes:\/\/logo\.png \(image\/png, 68 bytes\), saved to \S+-logo\.png\. This model cannot see images\.\]/,
    );
    const binary = /saved to (\S+\.bin)\./.exec(texts[4] ?? "")?.[1];
    expect(binary).toBeDefined();
    expect([...(await readFile(binary as string))]).toEqual([0, 1, 2, 3, 255]);
    // Past the cap, the start and the saved file.
    expect(texts[5]).toContain(
      "more than an MCP result may put in the conversation. It was saved to",
    );
    expect(texts[5]?.length).toBeLessThan(3_000);
    expect(await readFile(finished[5]?.display?.savedTo as string, "utf8")).toContain(
      "n".repeat(60_000),
    );
    expect(texts[6]).toContain("Notes for 2026-11-27.");
    expect(finished[7]?.outcome).toBe("error");
    expect(texts[7]).toContain("could not read notes://missing");
    expect(h.problems).toEqual([]);
  });

  it("are not in a session without MCP servers", async () => {
    h = await startHarness({ script: [text("Hi.")], engine: { mcp: FAST } });
    const s = await h.engine.createSession({ cwd: h.project });
    await s.run(prompt("Hello"));
    const names = toolNames(h);
    expect(names).not.toContain("ListMcpResourcesTool");
    expect(names).not.toContain("ReadMcpResourceTool");
  });
});

describe("a subagent's request for input", () => {
  const booker = (background: boolean) => ({
    replies: [],
    lanes: {
      booker: {
        match: { system: "You are the booker agent" },
        replies: [
          toolCall("mcp__forms__ask_name", {}, { id: "call_agent_ask" }),
          text("booker done"),
        ],
      },
      after: { match: { bodyIncludes: "booker done" }, replies: [text("All done.")] },
      parent: {
        match: { lastUser: "Book it" },
        replies: [
          toolCall("Agent", {
            description: "Book a table",
            prompt: "Ask the name.",
            subagent_type: "booker",
            ...(background ? { run_in_background: true } : {}),
          }),
          text("Started it."),
        ],
      },
    },
  });

  async function withAgent(harness: Harness, hooks: Record<string, unknown> = {}): Promise<string> {
    const log = await forms(harness);
    await writeJson(path.join(harness.home, ".dawg", "settings.json"), {
      permissions: { allow: ["mcp__forms"] },
      hooks,
    });
    await mkdir(path.join(harness.home, ".dawg", "agents"), { recursive: true });
    await writeFile(
      path.join(harness.home, ".dawg", "agents", "booker.md"),
      "---\nname: booker\ndescription: Books tables\n---\nYou book tables.\n",
    );
    return log;
  }

  const engine = (extra: Record<string, unknown> = {}) => ({
    mcp: FAST,
    subagents: true,
    assembler: createPromptAssembler(),
    capabilities: { permissionPrompts: false },
    ...extra,
  });

  it("is shown in the parent, labelled with the agent, and the parent's hooks run on it", async () => {
    h = await startHarness({
      script: booker(false),
      mock: { contextWindow: 200_000 },
      engine: engine(),
    });
    await withAgent(h, {
      ElicitationResult: [
        {
          matcher: "forms",
          hooks: [
            {
              type: "command",
              command: `echo '${JSON.stringify({ hookSpecificOutput: { action: "accept", content: { name: "Grace" } } })}'`,
            },
          ],
        },
      ],
    });
    const parent = await h.engine.createSession({ cwd: h.project });
    const done = parent.run(prompt("Book it"));
    const request = (await h.waitFor(asked(parent.id), 20_000)).payload as Record<string, unknown>;
    const agent = request.agent as { agentId: string; agentType: string; sessionId: string };
    expect(agent).toMatchObject({ agentType: "booker", description: "Book a table" });
    expect(agent.sessionId).not.toBe(parent.id);
    expect(request.toolCallId).toBe("call_agent_ask");
    // Only the parent shows it.
    expect(h.events.filter((e) => e.event === "elicitation.requested")).toHaveLength(1);
    expect(parent.pending()).toEqual([expect.objectContaining({ kind: "elicitation", agent })]);
    parent.respondElicitation(String(request.requestId), {
      action: "accept",
      content: { name: "Ada" },
    });
    await done;
    // The parent's ElicitationResult hook changed the answer before the server got it.
    expect(resultText(h, agent.sessionId)).toBe("Hello, Grace.");
    const ran = h
      .ofType(parent.id, "hook.ran")
      .map((e) => (e.payload.hook as { event: string }).event);
    expect(ran).toContain("ElicitationResult");
    expect(h.ofType(agent.sessionId, "hook.ran")).toEqual([]);
  });

  it("outlives the parent's turn when the agent works in the background", async () => {
    h = await startHarness({
      script: booker(true),
      mock: { contextWindow: 200_000 },
      engine: engine(),
    });
    await withAgent(h);
    const parent = await h.engine.createSession({ cwd: h.project });
    await parent.run(prompt("Book it"));
    const request = (await h.waitFor(asked(parent.id), 20_000)).payload as Record<string, unknown>;
    await h.waitFor((e) => e.event === "turn.finished" && e.payload.sessionId === parent.id);
    // The turn that started the agent is over; the form still waits, and so does the session.
    expect(parent.pending()).toHaveLength(1);
    expect(parent.status).toBe("waiting");
    parent.respondElicitation(String(request.requestId), {
      action: "accept",
      content: { name: "Ada" },
    });
    const agent = request.agent as { sessionId: string };
    await expect
      .poll(() => resultText(h as Harness, agent.sessionId), { timeout: 10_000 })
      .toBe("Hello, Ada.");
  });

  it("is cancelled when the parent's turn is interrupted", async () => {
    h = await startHarness({
      script: booker(false),
      mock: { contextWindow: 200_000 },
      engine: engine(),
    });
    const log = await withAgent(h);
    const parent = await h.engine.createSession({ cwd: h.project });
    const done = parent.run(prompt("Book it"));
    const request = (await h.waitFor(asked(parent.id), 20_000)).payload as Record<string, unknown>;
    expect(parent.interrupt()).toBe(true);
    expect((await done)?.stopReason).toBe("interrupted");
    expect(h.ofType(parent.id, "request.resolved").at(-1)?.payload).toMatchObject({
      kind: "elicitation",
      requestId: request.requestId,
      outcome: "cancelled",
    });
    expect(parent.pending()).toEqual([]);
    await expect.poll(async () => readFile(log, "utf8")).toContain('"action":"cancel"');
  });

  it("is declined at once when nobody can answer the parent", async () => {
    h = await startHarness({
      script: booker(false),
      mock: { contextWindow: 200_000 },
      engine: engine({ capabilities: { permissionPrompts: false, elicitation: false } }),
    });
    await withAgent(h);
    const parent = await h.engine.createSession({ cwd: h.project });
    await parent.run(prompt("Book it"));
    expect(h.events.filter((e) => e.event === "elicitation.requested")).toEqual([]);
    const child = h.events.find(
      (e) => e.event === "tool.finished" && e.payload.toolName === "mcp__forms__ask_name",
    );
    const content = (child?.payload.content ?? []) as { text?: string }[];
    const text = content.map((p) => p.text).join("\n");
    expect(text).toBe(`decline\n${nobodyNote("forms")}`);
  });
});
