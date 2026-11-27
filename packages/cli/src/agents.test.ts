/**
 * Subagents on the command line: one compact line per agent as its state changes, its
 * permission prompts labelled with it, and headless runs that wait for background agents.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { type ScriptReply, text, toolCall } from "@dawg/mock-model";
import type { PermissionRequest, SubagentInfo } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./__fixtures__/harness.ts";
import { EXIT } from "./exit-codes.ts";
import { agentLine, describeInput, permissionLines } from "./render.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const agent: SubagentInfo = {
  agentId: "agent-1",
  sessionId: "s-agent-1",
  agentType: "Explore",
  description: "Find the port",
  toolCallId: "c1",
  turnId: "turn-1",
  fork: false,
  background: false,
  status: "running",
  queuePosition: null,
  worktree: null,
  startedAt: 0,
  endedAt: null,
  toolUses: 0,
  activity: null,
  result: null,
  error: null,
};

describe("lines for people", () => {
  it("gives one line per state", () => {
    expect(agentLine({ ...agent, status: "queued", queuePosition: 2 })).toBe(
      "[agent-1 Explore] Find the port: queued (2 in line for the model)",
    );
    expect(agentLine(agent)).toBe("[agent-1 Explore] Find the port: running");
    expect(agentLine({ ...agent, status: "completed", toolUses: 3 })).toBe(
      "[agent-1 Explore] Find the port: done, 3 tool uses",
    );
    expect(
      agentLine({
        ...agent,
        status: "failed",
        error: { kind: "other", message: "It broke.", detail: null, retryable: false },
      }),
    ).toBe("[agent-1 Explore] Find the port: failed: It broke.");
    expect(describeInput("Agent", { description: "Find it", subagent_type: "Plan" }, "/p")).toBe(
      "Plan: Find it",
    );
  });

  it("labels a subagent's permission request with the agent", () => {
    const request: PermissionRequest = {
      requestId: "r1",
      toolCallId: "c9",
      toolName: "Bash",
      input: { command: "touch x" },
      title: "Run a shell command",
      reason: "No rule allows this command",
      suggestions: [],
      agent: {
        agentId: "agent-2",
        sessionId: "s-agent-2",
        agentType: "general-purpose",
        description: "Make files",
      },
    };
    expect(permissionLines(request, "/p")[0]).toBe(
      "Permission needed (agent-2, general-purpose agent: Make files): Run a shell command",
    );
  });
});

/** Titles take their own lane; requests without tools are side requests. */
function script(lanes: Record<string, { match: object; replies: ScriptReply[] }>) {
  return {
    replies: [],
    lanes: { title: { match: { hasTools: false }, replies: [text("A title")] }, ...lanes },
  };
}

describe("headless runs", () => {
  it("print the parent's answer after a foreground agent", async () => {
    h = await startHarness({
      mock: { contextWindow: 200_000 },
      script: script({
        explore: {
          match: { system: "You are the Explore agent" },
          replies: [toolCall("Read", { file_path: "port.txt" }), text("Port 4711.")],
        },
        after: { match: { bodyIncludes: "Port 4711." }, replies: [text("It is 4711.")] },
        parent: {
          match: { lastUser: "Which port" },
          replies: [
            toolCall("Agent", {
              description: "Find the port",
              prompt: "Read port.txt",
              subagent_type: "Explore",
            }),
          ],
        },
      }),
    });
    await writeFile(path.join(h.project, "port.txt"), "4711\n");
    const result = await h.run(["-p", "Which port?", "--verbose", "--endpoint", h.mock.baseUrl]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toBe("It is 4711.\n");
    expect(result.stderr).toContain("[agent-1 Explore] Find the port: done, 1 tool use");
  });

  it("wait for a background agent and the turn it wakes the session with", async () => {
    h = await startHarness({
      mock: { contextWindow: 200_000 },
      script: script({
        worker: {
          match: { system: "You are a general-purpose agent" },
          replies: [text("Background result: 42.")],
        },
        woken: {
          match: { lastUser: "Background agent agent-1 finished" },
          replies: [text("The agent says 42.")],
        },
        parent: {
          match: { lastUser: "Count in the background" },
          replies: [
            toolCall("Agent", {
              description: "Count",
              prompt: "Count to 42",
              run_in_background: true,
            }),
            text("Started it."),
          ],
        },
      }),
    });
    const result = await h.run(["-p", "Count in the background", "--endpoint", h.mock.baseUrl]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toBe("The agent says 42.\n");
  });
});
