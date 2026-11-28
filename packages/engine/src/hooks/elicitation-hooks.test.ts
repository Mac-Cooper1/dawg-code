/**
 * Elicitation and ElicitationResult hooks, and the elicitation Notification types, against the
 * forms test server (../mcp/__fixtures__/elicit-server.ts): a hook answering a form in the
 * person's place, its answer refused when the form would refuse it, a decline that wins, a hook
 * changing the person's answer, and a Notification when a form has waited.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { text, toolCall } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../runtime/__fixtures__/harness.ts";
import type { LoggedEvent } from "../runtime/event-log.ts";

const SERVER = fileURLToPath(new URL("../mcp/__fixtures__/elicit-server.ts", import.meta.url));
const FAST = { restartDelaysMs: [50], lingerMs: 0, connectTimeoutMs: 10_000 };

let h: Harness | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

/** The forms server as the person's own, with these hooks in their settings. */
async function forms(harness: Harness, hooks: Record<string, unknown>): Promise<string> {
  const log = path.join(harness.root, "server.log");
  await writeJson(path.join(harness.home, ".dawg", "mcp.json"), {
    mcpServers: { forms: { command: process.execPath, args: [SERVER, "--log", log] } },
  });
  await writeJson(path.join(harness.home, ".dawg", "settings.json"), {
    permissions: { allow: ["mcp__forms"] },
    hooks,
  });
  return log;
}

const ask = (words: string) => ({ content: [{ type: "text" as const, text: words }] });
const answer = (value: unknown, file?: string) => ({
  type: "command",
  command: `${file === undefined ? "" : `cat > '${file}'; `}echo '${JSON.stringify(value)}'`,
});
const asked = (sessionId: string) => (e: LoggedEvent) =>
  e.event === "elicitation.requested" && e.payload.sessionId === sessionId;

function resultText(harness: Harness, sessionId: string): string {
  const payload = harness.ofType(sessionId, "tool.finished").at(-1)?.payload as
    | { content?: { type: string; text?: string }[] }
    | undefined;
  return (payload?.content ?? []).map((p) => p.text ?? "").join("\n");
}

describe("Elicitation hooks", () => {
  it("answer a form in the person's place, so it is never shown, with the documented input", async () => {
    h = await startHarness({
      script: [toolCall("mcp__forms__ask_name", {}, { id: "c1" }), text("Greeted.")],
      engine: { mcp: FAST },
    });
    const input = path.join(h.root, "elicitation.json");
    await forms(h, {
      Elicitation: [
        {
          matcher: "forms",
          hooks: [
            answer(
              {
                hookSpecificOutput: {
                  hookEventName: "Elicitation",
                  action: "accept",
                  content: { name: "Ada" },
                },
              },
              input,
            ),
          ],
        },
      ],
      ElicitationResult: [{ hooks: [answer({ hookSpecificOutput: { action: "decline" } })] }],
    });
    const s = await h.engine.createSession({ cwd: h.project });
    await s.run(ask("Greet me"));
    expect(h.ofType(s.id, "elicitation.requested")).toEqual([]);
    expect(resultText(h, s.id)).toContain("Hello, Ada.");
    expect(JSON.parse(await readFile(input, "utf8"))).toMatchObject({
      hook_event_name: "Elicitation",
      mcp_server_name: "forms",
      message: "What should I call you?",
      mode: "form",
      requested_schema: { type: "object", required: ["name"] },
    });
    // When an Elicitation hook answers, ElicitationResult hooks do not run.
    const ran = h.ofType(s.id, "hook.ran").map((e) => e.payload);
    expect(ran.map((r) => (r.hook as { event: string }).event)).toEqual(["Elicitation"]);
    expect(ran[0]).toMatchObject({ toolCallId: "c1", decision: "allow", outcome: "success" });
  });

  it("refuse an answer the form would refuse, and the person is asked instead", async () => {
    h = await startHarness({
      script: [toolCall("mcp__forms__ask_name", {}), text("Greeted.")],
      engine: { mcp: FAST },
    });
    await forms(h, {
      Elicitation: [
        // `name` needs at least one character.
        { hooks: [answer({ hookSpecificOutput: { action: "accept", content: { name: "" } } })] },
      ],
    });
    const s = await h.engine.createSession({ cwd: h.project });
    const done = s.run(ask("Greet me"));
    const request = (await h.waitFor(asked(s.id))).payload as unknown as { requestId: string };
    expect(h.ofType(s.id, "hook.ran")[0]?.payload).toMatchObject({ outcome: "error" });
    expect(String(h.ofType(s.id, "hook.ran")[0]?.payload.message)).toContain(
      "does not fit the form",
    );
    s.respondElicitation(request.requestId, { action: "accept", content: { name: "Grace" } });
    await done;
    expect(resultText(h, s.id)).toContain("Hello, Grace.");
  });

  it("decline with exit 2, which wins over another hook's accept; and answer where nobody could", async () => {
    h = await startHarness({
      script: [toolCall("mcp__forms__ask_name", {}), text("ok")],
      // Nobody to ask: without the hooks this would be declined with a note for the model.
      engine: { mcp: FAST, capabilities: { elicitation: false } },
    });
    await forms(h, {
      Elicitation: [
        { hooks: [answer({ hookSpecificOutput: { action: "accept", content: { name: "Ada" } } })] },
        { hooks: [{ type: "command", command: "echo 'not this server' >&2; exit 2" }] },
      ],
    });
    const s = await h.engine.createSession({ cwd: h.project });
    await s.run(ask("Greet me"));
    expect(resultText(h, s.id)).toContain("decline");
    // Declined by a hook, not for want of someone to ask.
    expect(resultText(h, s.id)).not.toContain("nobody can answer");
  });
});

describe("ElicitationResult hooks", () => {
  it("change the person's answer before the server gets it, with the documented input", async () => {
    h = await startHarness({
      script: [toolCall("mcp__forms__ask_name", {}, { id: "c1" }), text("Greeted.")],
      engine: { mcp: FAST },
    });
    const input = path.join(h.root, "result.json");
    await forms(h, {
      ElicitationResult: [
        {
          matcher: "forms",
          hooks: [
            answer(
              {
                hookSpecificOutput: {
                  hookEventName: "ElicitationResult",
                  action: "accept",
                  content: { name: "Ada Lovelace" },
                },
              },
              input,
            ),
          ],
        },
      ],
    });
    const s = await h.engine.createSession({ cwd: h.project });
    const done = s.run(ask("Greet me"));
    const request = (await h.waitFor(asked(s.id))).payload as unknown as { requestId: string };
    s.respondElicitation(request.requestId, { action: "accept", content: { name: "Ada" } });
    await done;
    expect(resultText(h, s.id)).toContain("Hello, Ada Lovelace.");
    expect(JSON.parse(await readFile(input, "utf8"))).toMatchObject({
      hook_event_name: "ElicitationResult",
      mcp_server_name: "forms",
      action: "accept",
      mode: "form",
      content: { name: "Ada" },
    });
  });

  it("run when the person declines too; a block declines what they accepted; no output leaves it", async () => {
    const run = async (hook: Record<string, unknown>, action: "accept" | "decline") => {
      h = await startHarness({
        script: [toolCall("mcp__forms__ask_name", {}), text("ok")],
        engine: { mcp: FAST },
      });
      await forms(h, { ElicitationResult: [{ hooks: [hook] }] });
      const s = await h.engine.createSession({ cwd: h.project });
      const done = s.run(ask("Greet me"));
      const request = (await h.waitFor(asked(s.id))).payload as unknown as { requestId: string };
      s.respondElicitation(
        request.requestId,
        action === "accept" ? { action, content: { name: "Ada" } } : { action },
      );
      await done;
      const out = resultText(h, s.id);
      await h.close();
      h = null;
      return out;
    };
    expect(await run(answer({ decision: "block" }), "accept")).toContain("decline");
    expect(await run({ type: "command", command: "exit 0" }, "accept")).toContain("Hello, Ada.");
    // An accept without content keeps what the person typed; here they declined, so there is
    // none, and the form refuses the empty answer: their decline stands.
    expect(await run(answer({ hookSpecificOutput: { action: "accept" } }), "decline")).toContain(
      "decline",
    );
    expect(
      await run(
        answer({ hookSpecificOutput: { action: "accept", content: { name: "Grace" } } }),
        "decline",
      ),
    ).toContain("Hello, Grace.");
  });
});

describe("Notification hooks for elicitation", () => {
  it("fire elicitation_dialog when a form has waited, and elicitation_response once answered", async () => {
    h = await startHarness({
      script: [toolCall("mcp__forms__ask_name", {}), text("ok")],
      engine: { mcp: FAST, limits: { permissionNotificationMs: 50 } },
    });
    const log = path.join(h.root, "notified");
    await forms(h, {
      Notification: [
        {
          matcher: "elicitation_dialog|elicitation_response",
          hooks: [{ type: "command", command: `cat >> '${log}'; echo >> '${log}'` }],
        },
      ],
    });
    const s = await h.engine.createSession({ cwd: h.project });
    const done = s.run(ask("Greet me"));
    const request = (await h.waitFor(asked(s.id))).payload as unknown as { requestId: string };
    await h.waitFor(
      (e) =>
        e.event === "hook.ran" &&
        e.payload.sessionId === s.id &&
        (e.payload.hook as { event: string }).event === "Notification",
    );
    s.respondElicitation(request.requestId, { action: "accept", content: { name: "Ada" } });
    await done;
    await h.waitFor(
      (e) =>
        e.event === "hook.ran" &&
        e.payload.sessionId === s.id &&
        h?.ofType(s.id, "hook.ran").length === 2,
    );
    const sent = (await readFile(log, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(sent).toEqual([
      expect.objectContaining({
        hook_event_name: "Notification",
        notification_type: "elicitation_dialog",
        message: "forms asks for your input",
      }),
      expect.objectContaining({ notification_type: "elicitation_response" }),
    ]);
  });
});
