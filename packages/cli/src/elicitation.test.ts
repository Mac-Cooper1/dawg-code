/**
 * An MCP server's request for input on the command line: interactive mode asks for each field
 * (and offers a URL to open), a `-p` run declines at once, against the engine's stdio test server
 * whose tools ask while their call is in progress.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { text, toolCall } from "@dawg/mock-model";
import type { ElicitationField, EventPayload } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./__fixtures__/harness.ts";
import { answerElicitation, plain, valueFromText } from "./elicitation.ts";
import { EXIT } from "./exit-codes.ts";

const SERVER = fileURLToPath(
  new URL("../../engine/src/mcp/__fixtures__/elicit-server.ts", import.meta.url),
);

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function withForms(harness: Harness): Promise<void> {
  await mkdir(path.join(harness.home, ".dawg"), { recursive: true });
  await writeFile(
    path.join(harness.home, ".dawg", "mcp.json"),
    JSON.stringify({ mcpServers: { forms: { command: process.execPath, args: [SERVER] } } }),
  );
  await writeFile(
    path.join(harness.home, ".dawg", "settings.json"),
    JSON.stringify({ permissions: { allow: ["mcp__forms"] } }),
  );
}

function withTitles(replies: ReturnType<typeof text>[]) {
  return {
    replies,
    lanes: { title: { match: { hasTools: false }, replies: [text("A title"), text("A title")] } },
  };
}

/** The tool result the model was sent next, from the request after the call. */
function sentBack(harness: Harness, index: number): string {
  return JSON.stringify(harness.mock.chatRequests.filter((r) => r.lane === "main")[index]?.body);
}

describe("a server's request for input at the terminal", () => {
  it("asks for each field, checks the answers, and sends them once the person agrees", async () => {
    h = await startHarness({
      script: withTitles([toolCall("mcp__forms__book"), text("Booked it.")]),
    });
    await withForms(h);
    const child = h.spawn(["--endpoint", h.mock.baseUrl]);
    const stdin = child.process.stdin;
    if (stdin === null) throw new Error("no stdin");
    stdin.write("Book a table\n");
    await child.waitForStdout("The MCP server forms asks for input: Book a table.");
    await child.waitForStdout("Name: ");
    stdin.write("A\n"); // too short
    await child.waitForStdout("Use at least 2 characters.");
    stdin.write("Ada\n");
    await child.waitForStdout("Email: ");
    stdin.write("ada@example.com\n");
    await child.waitForStdout("Day: ");
    stdin.write("2026-02-30\n");
    await child.waitForStdout("Enter a date as YYYY-MM-DD.");
    stdin.write("2026-12-01\n");
    await child.waitForStdout("Arrival: ");
    stdin.write("\n");
    await child.waitForStdout("Website: ");
    stdin.write("\n");
    await child.waitForStdout("Guests [2]: ");
    stdin.write("\n"); // keeps the default
    await child.waitForStdout("Budget: ");
    stdin.write("\n");
    await child.waitForStdout("Sit outside [no]: ");
    stdin.write("y\n");
    await child.waitForStdout("Room [Main room]: ");
    stdin.write("2\n");
    await child.waitForStdout("Course: ");
    stdin.write("\n");
    await child.waitForStdout("Extras: ");
    stdin.write("1, 2, 3\n");
    await child.waitForStdout("Pick at most 2.");
    stdin.write("1,3\n");
    await child.waitForStdout("Diet: ");
    stdin.write("\n");
    await child.waitForStdout("Send? ");
    stdin.write("y\n");
    await child.waitForStdout("Booked it.");
    stdin.end();
    const result = await child.exited;
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("To send to forms:");
    expect(result.stdout).toContain("  Room: Garden");
    expect(result.stdout).toContain("  Extras: Birthday cake, Music");
    expect(result.stdout).toContain("  Course: (left out)");
    expect(sentBack(h, 1)).toContain(
      'booked: {\\"name\\":\\"Ada\\",\\"email\\":\\"ada@example.com\\",\\"day\\":\\"2026-12-01\\",\\"guests\\":2,\\"outside\\":true,\\"room\\":\\"garden\\",\\"extras\\":[\\"cake\\",\\"music\\"]}',
    );
  });

  it("shows a page's site and address, opens it only when asked, and takes /decline", async () => {
    h = await startHarness({
      script: withTitles([
        toolCall("mcp__forms__sign_in"),
        text("Signed in."),
        toolCall("mcp__forms__ask_name"),
        text("Fine."),
      ]),
    });
    await withForms(h);
    const child = h.spawn(["--endpoint", h.mock.baseUrl]);
    const stdin = child.process.stdin;
    if (stdin === null) throw new Error("no stdin");
    stdin.write("Sign me in\n");
    await child.waitForStdout("Open it in your browser?");
    expect(child.stdout()).toContain(
      "  Site: example.com\n  Address: https://example.com/connect?session=test",
    );
    stdin.write("o\n");
    // The tests' BROWSER is none: nothing opens, and it says so.
    await child.waitForStdout("Could not open the browser. Open the address above yourself");
    await child.waitForStdout("Signed in.");
    stdin.write("Ask my name\n");
    await child.waitForStdout("Your name: ");
    stdin.write("/decline\n");
    await child.waitForStdout("Fine.");
    stdin.end();
    expect((await child.exited).code).toBe(EXIT.ok);
    expect(sentBack(h, 1)).toContain("sign in: accept");
    expect(sentBack(h, 3)).toContain("decline");
  });

  it("asks a background agent's form at the prompt, labelled with the agent", async () => {
    h = await startHarness({
      script: {
        replies: [],
        lanes: {
          title: { match: { hasTools: false }, replies: [text("A title"), text("A title")] },
          booker: {
            match: { system: "You are the booker agent" },
            replies: [toolCall("mcp__forms__ask_name"), text("booker done")],
          },
          after: { match: { bodyIncludes: "booker done" }, replies: [text("All done.")] },
          parent: {
            match: { lastUser: "Book it" },
            replies: [
              toolCall("Agent", {
                description: "Book a table",
                prompt: "Ask the name.",
                subagent_type: "booker",
                run_in_background: true,
              }),
              text("Started it."),
            ],
          },
        },
      },
    });
    await withForms(h);
    await mkdir(path.join(h.home, ".dawg", "agents"), { recursive: true });
    await writeFile(
      path.join(h.home, ".dawg", "agents", "booker.md"),
      "---\nname: booker\ndescription: Books tables\n---\nYou book tables.\n",
    );
    const child = h.spawn(["--endpoint", h.mock.baseUrl]);
    const stdin = child.process.stdin;
    if (stdin === null) throw new Error("no stdin");
    stdin.write("Book it\n");
    await child.waitForStdout("Started it.");
    await child.waitForStdout(
      /The MCP server forms asks for input \(agent-\d+, booker agent: Book a table\): What should I call you\?/,
    );
    await child.waitForStdout("Your name: ");
    stdin.write("Ada\n");
    await child.waitForStdout("Send? ");
    stdin.write("y\n");
    await child.waitForStdout("All done.", 20_000);
    stdin.end();
    expect((await child.exited).code).toBe(EXIT.ok);
    const agentAsked = h.mock.chatRequests.filter((r) => r.lane === "booker");
    expect(JSON.stringify(agentAsked[1]?.body)).toContain("Hello, Ada.");
  });

  it("declines at once in a -p run, and the model is told why", async () => {
    h = await startHarness({
      script: [toolCall("mcp__forms__ask_name"), text("Nobody answered.")],
    });
    await withForms(h);
    const result = await h.run(["-p", "Ask my name", "--endpoint", h.mock.baseUrl]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("Nobody answered.");
    const back = sentBack(h, 1);
    expect(back).toContain("decline");
    expect(back).toContain("nobody can answer such a request in this session");
  });
});

describe("reading answers", () => {
  const common = { title: null, description: null, required: false, default: null };
  const pick: ElicitationField = {
    ...common,
    name: "size",
    type: "select",
    options: [
      { value: "s", title: "Small" },
      { value: "m", title: null },
    ],
  };

  it("turns typed text into each kind of value", () => {
    expect(valueFromText(pick, "2")).toEqual({ value: "m" });
    expect(valueFromText(pick, "Small")).toEqual({ value: "s" });
    expect(valueFromText(pick, "9")).toEqual({ problem: "Pick one of the choices." });
    expect(
      valueFromText({ ...common, name: "n", type: "integer", minimum: null, maximum: null }, "x"),
    ).toEqual({
      problem: "Enter a number.",
    });
    expect(valueFromText({ ...common, name: "b", type: "boolean" }, "yes")).toEqual({
      value: true,
    });
  });

  it("keeps a server's control characters off the terminal, and cancels at the end of input", async () => {
    expect(plain("red\u001b[31m text\r")).toBe("red[31m text");
    const lines: string[] = [];
    const payload = {
      sessionId: "s",
      seq: 1,
      time: 1,
      turnId: "t",
      requestId: "r",
      toolCallId: null,
      server: "forms",
      message: "Pick\u0007 one",
      mode: "form",
      fields: [pick],
      url: null,
    } as EventPayload<"elicitation.requested">;
    const answer = await answerElicitation(payload, {
      ask: async () => null,
      line: (t) => lines.push(t),
      open: async () => false,
    });
    expect(answer).toEqual({ action: "cancel" });
    expect(lines[0]).toBe("The MCP server forms asks for input: Pick one");
  });
});
