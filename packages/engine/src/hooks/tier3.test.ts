/**
 * The tier 3 events built so far, in whole sessions: PostToolBatch once per batch (context,
 * and a block that ends the turn), UserPromptExpansion before a typed command expands (blocking
 * it, or adding context), and StopFailure when a turn ends on the model server's error.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { text, toolCall } from "@dawg/mock-model";
import { RpcError } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Setup as HostSetup, setup as hostSetup } from "../host/__fixtures__/setup.ts";
import { type Harness, startHarness } from "../runtime/__fixtures__/harness.ts";

let h: Harness | null = null;
let host: HostSetup | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
  await host?.close();
  host = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const settings = (hooks: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ hooks, ...extra });
const command = (cmd: string) => ({ type: "command", command: cmd });
const json = (value: unknown, file?: string) =>
  `${file === undefined ? "" : `cat > '${file}'; `}echo '${JSON.stringify(value)}'`;

async function personal(home: string, content: string): Promise<void> {
  await mkdir(path.join(home, ".dawg"), { recursive: true });
  await writeFile(path.join(home, ".dawg", "settings.json"), content);
}

describe("PostToolBatch", () => {
  it("runs once per batch with every call's result, and its context reaches the next request", async () => {
    h = await startHarness({
      files: { "a.txt": "alpha\n", "b.txt": "beta\n" },
      script: [
        {
          toolCalls: [
            { id: "r1", name: "Read", arguments: { file_path: "a.txt" } },
            { id: "r2", name: "Read", arguments: { file_path: "b.txt" } },
          ],
        },
        text("Read both."),
      ],
    });
    const input = path.join(h.root, "batch.json");
    await personal(
      h.home,
      settings({
        PostToolBatch: [
          {
            hooks: [
              command(
                json(
                  {
                    hookSpecificOutput: {
                      hookEventName: "PostToolBatch",
                      additionalContext: "Both files belong to the ledger module.",
                    },
                  },
                  input,
                ),
              ),
            ],
          },
        ],
      }),
    );
    const session = await h.engine.createSession({ cwd: h.project });
    const outcome = await session.run(ask("read a and b"));
    expect(outcome.finalText).toBe("Read both.");
    const sent = JSON.parse(await readFile(input, "utf8"));
    expect(sent.hook_event_name).toBe("PostToolBatch");
    expect(sent.tool_calls.map((c: { tool_use_id: string }) => c.tool_use_id)).toEqual([
      "r1",
      "r2",
    ]);
    expect(sent.tool_calls[0]).toMatchObject({
      tool_name: "Read",
      tool_input: { file_path: "a.txt" },
    });
    expect(sent.tool_calls[0].tool_response).toContain("alpha");
    expect(h.ofType(session.id, "hook.ran")).toHaveLength(1);
    expect(JSON.stringify(h.mock.messages(1))).toContain("Both files belong to the ledger module.");
  });

  it("a block ends the turn before the next request, and the reason stays for the model", async () => {
    h = await startHarness({
      files: { "a.txt": "alpha\n" },
      script: [toolCall("Read", { file_path: "a.txt" }), text("never sent"), text("next turn")],
    });
    await personal(
      h.home,
      settings({
        PostToolBatch: [
          { hooks: [command(json({ decision: "block", reason: "Stop and run pytest first" }))] },
        ],
      }),
    );
    const session = await h.engine.createSession({ cwd: h.project });
    const outcome = await session.run(ask("read a"));
    expect(outcome.stopReason).toBe("completed");
    expect(h.mock.chatRequests).toHaveLength(1);
    expect(h.ofType(session.id, "hook.ran")[0]?.payload).toMatchObject({
      outcome: "blocked",
      decision: "block",
      message: "Stop and run pytest first",
    });
    await session.run(ask("go on"));
    expect(JSON.stringify(h.mock.messages(1))).toContain("Stop and run pytest first");
  });
});

describe("UserPromptExpansion", () => {
  const FILES = {
    ".dawg/commands/deploy.md": "Deploy to $ARGUMENTS. Branch: !`echo main`\n",
  };

  it("a block stops the command before it expands, and the person is told why", async () => {
    host = await hostSetup({ files: FILES, script: [text("never")] });
    const marker = path.join(host.root, "expansion.json");
    await personal(
      host.home,
      settings({
        UserPromptExpansion: [
          {
            matcher: "deploy",
            hooks: [command(`cat > '${marker}'; echo 'Deploys need an approval file' >&2; exit 2`)],
          },
        ],
      }),
    );
    const c = await host.connect();
    const { session } = await c.client.request("session.create", { cwd: host.project });
    const failed = await c.client
      .request("session.command", { sessionId: session.id, name: "deploy", args: "staging" })
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(RpcError);
    expect((failed as RpcError).message).toContain(
      "A UserPromptExpansion hook blocked /deploy: Deploys need an approval file",
    );
    expect(host.mock.chatRequests).toHaveLength(0);
    expect(JSON.parse(await readFile(marker, "utf8"))).toMatchObject({
      hook_event_name: "UserPromptExpansion",
      expansion_type: "slash_command",
      command_name: "deploy",
      command_args: "staging",
      command_source: "projectSettings",
      prompt: "/deploy staging",
    });
  });

  it("adds its context alongside the expanded prompt; a matcher for another command does not run", async () => {
    // No inline shell, so it needs no approval of the project's code.
    host = await hostSetup({
      files: { ".dawg/commands/deploy.md": "Deploy to $ARGUMENTS.\n" },
      script: [text("Deploying.")],
    });
    await personal(
      host.home,
      settings({
        UserPromptExpansion: [
          {
            matcher: "deploy",
            hooks: [
              command(
                json({
                  hookSpecificOutput: {
                    hookEventName: "UserPromptExpansion",
                    additionalContext: "Staging is frozen until Monday.",
                  },
                }),
              ),
            ],
          },
          { matcher: "review", hooks: [command("exit 2")] },
        ],
      }),
    );
    const c = await host.connect();
    const { session } = await c.client.request("session.create", { cwd: host.project });
    await c.client.request("session.command", {
      sessionId: session.id,
      name: "deploy",
      args: "staging",
    });
    await c.waitFor((e) => e.event === "turn.finished" && e.payload.sessionId === session.id);
    const request = JSON.stringify(host.mock.chatRequests[0]?.body);
    expect(request).toContain("Staging is frozen until Monday.");
    expect(request).toContain("Deploy to staging.");
    const ran = c.events.filter((e) => e.event === "hook.ran");
    expect(ran).toHaveLength(1);
  });
});

describe("StopFailure", () => {
  it("runs when a turn ends on the model server's error, with the reference's error name", async () => {
    h = await startHarness({
      script: [
        { fault: { type: "http", status: 429, body: "slow down" } },
        { fault: { type: "http", status: 429, body: "slow down" } },
      ],
    });
    const input = path.join(h.root, "failure.json");
    await personal(
      h.home,
      settings({
        StopFailure: [{ matcher: "rate_limit", hooks: [command(`cat > '${input}'`)] }],
        Stop: [{ hooks: [command("exit 0")] }],
      }),
    );
    const session = await h.engine.createSession({ cwd: h.project });
    const outcome = await session.run(ask("hi"));
    expect(outcome.stopReason).toBe("error");
    await h.waitFor((e) => e.event === "hook.ran");
    const sent = JSON.parse(await readFile(input, "utf8"));
    expect(sent).toMatchObject({ hook_event_name: "StopFailure", error: "rate_limit" });
    expect(sent.last_assistant_message).toContain("HTTP 429");
    // Instead of Stop: the Stop hook did not run.
    const events = h
      .ofType(session.id, "hook.ran")
      .map((e) => (e.payload.hook as { event: string }).event);
    expect(events).toEqual(["StopFailure"]);
  });
});
