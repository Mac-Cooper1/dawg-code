/**
 * Rewinding a session whose subagents changed files: their changes count in the checkpoint of
 * the parent's turn that started them, foreground or background, are listed with the agent, and
 * are put back by the parent's rewind. A rewind waits while one still works in the background.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type ScriptReply, stalled, text, toolCall } from "@dawg/mock-model";
import type { SubagentInfo } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createPromptAssembler } from "../prompt/index.ts";
import {
  type Harness,
  type HarnessOptions,
  startHarness,
} from "../runtime/__fixtures__/harness.ts";
import { rewindSession } from "../runtime/rewind.ts";

let h: Harness | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function start(options: HarnessOptions): Promise<Harness> {
  return startHarness({
    ...options,
    mock: { contextWindow: 200_000, ...options.mock },
    engine: { subagents: true, assembler: createPromptAssembler(), ...options.engine },
  });
}

const WORKER = { system: "You are a general-purpose agent" };

/** The agent reads notes.txt and changes it. */
const AGENT_EDITS: ScriptReply[] = [
  toolCall("Read", { file_path: "notes.txt" }),
  toolCall("Edit", { file_path: "notes.txt", old_string: "original", new_string: "by the agent" }),
  text("Changed the notes."),
];

const notesOf = (harness: Harness) => readFile(path.join(harness.project, "notes.txt"), "utf8");

function agentStatus(harness: Harness, status: SubagentInfo["status"]) {
  return harness.waitFor(
    (e) =>
      e.event === "subagent.updated" &&
      (e.payload as unknown as { agent: SubagentInfo }).agent.status === status,
  );
}

describe("a subagent's file changes", () => {
  it("in the foreground count in the turn that started it, and the parent's rewind puts them back", async () => {
    h = await start({
      files: { "notes.txt": "original\n" },
      script: {
        lanes: {
          worker: { match: WORKER, replies: AGENT_EDITS },
          after: {
            match: { bodyIncludes: "Changed the notes." },
            replies: [text("The agent changed them.")],
          },
          parent: {
            match: { lastUser: "Tidy the notes" },
            replies: [
              toolCall("Agent", {
                description: "Tidy the notes",
                prompt: "Change original to something better in notes.txt.",
                subagent_type: "general-purpose",
              }),
            ],
          },
        },
      },
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "acceptEdits" });
    const outcome = await session.run(ask("Tidy the notes"));
    expect(outcome.finalText).toBe("The agent changed them.");
    expect(await notesOf(h)).toBe("by the agent\n");

    const { checkpoints } = await session.checkpoints();
    expect(checkpoints).toHaveLength(1);
    const notes = path.join(h.project, "notes.txt");
    expect(checkpoints[0]?.files).toEqual([
      {
        path: notes,
        change: "modified",
        agents: [
          {
            agentId: "agent-1",
            sessionId: `${session.id}-agent-1`,
            agentType: "general-purpose",
            description: "Tidy the notes",
          },
        ],
      },
    ]);
    // The agent's write is dawg's: nothing changed outside.
    expect(checkpoints[0]?.restore).toEqual([
      { path: notes, action: "write", changedOutside: false },
    ]);

    const rewound = await rewindSession(h.engine, session, {
      checkpointId: checkpoints[0]?.id as string,
      action: "both",
      overwrite: false,
      instructions: null,
    });
    expect(rewound.files?.restored).toEqual([notes]);
    expect(await notesOf(h)).toBe("original\n");
    expect(rewound.session).not.toBeNull();
  });

  it("in the background count in the turn that started it, once it has finished", async () => {
    h = await start({
      files: { "notes.txt": "original\n" },
      script: {
        lanes: {
          worker: { match: WORKER, replies: AGENT_EDITS },
          woken: {
            match: { lastUser: "Background agent agent-1 finished" },
            replies: [text("The agent is done.")],
          },
          parent: {
            match: { lastUser: "Tidy the notes in the background" },
            replies: [
              toolCall("Agent", {
                description: "Tidy the notes",
                prompt: "Change original to something better in notes.txt.",
                run_in_background: true,
              }),
              text("Started it."),
            ],
          },
        },
      },
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "acceptEdits" });
    await session.run(ask("Tidy the notes in the background"));
    // The agent finishes, and the idle parent is woken with a turn of its own.
    await h.waitFor(
      (e) =>
        e.payload.sessionId === session.id &&
        e.event === "turn.finished" &&
        e.payload.finalText === "The agent is done.",
    );
    await session.waitForIdle();
    expect(await notesOf(h)).toBe("by the agent\n");

    const { checkpoints } = await session.checkpoints();
    expect(checkpoints.map((c) => c.prompt)).toEqual([
      "Tidy the notes in the background",
      expect.stringContaining("Background agent agent-1 finished"),
    ]);
    // The change is in the checkpoint of the turn that started the agent, not the wake-up's.
    expect(checkpoints[0]?.files.map((f) => f.agents.map((a) => a.agentId))).toEqual([["agent-1"]]);
    expect(checkpoints[1]?.files).toEqual([]);

    const outcome = await session.restoreFiles(checkpoints[0]?.id as string, false);
    expect(outcome.restored).toEqual([path.join(h.project, "notes.txt")]);
    expect(await notesOf(h)).toBe("original\n");
  });

  it("make a rewind wait while the agent still works in the background", async () => {
    h = await start({
      files: { "notes.txt": "original\n" },
      script: {
        lanes: {
          worker: { match: WORKER, replies: [stalled(text("working"))] },
          parent: {
            match: { lastUser: "Start it" },
            replies: [
              toolCall("Agent", {
                description: "Long job",
                prompt: "Work for a long time.",
                run_in_background: true,
              }),
              text("Started."),
            ],
          },
        },
      },
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "acceptEdits" });
    await session.run(ask("Start it"));
    await agentStatus(h, "running");
    const { checkpoints } = await session.checkpoints();
    const rewind = () =>
      rewindSession((h as Harness).engine, session, {
        checkpointId: checkpoints[0]?.id as string,
        action: "files",
        overwrite: false,
        instructions: null,
      });
    await expect(rewind()).rejects.toMatchObject({
      code: "InvalidState",
      message: expect.stringContaining("agent-1 (general-purpose)"),
    });
    expect(await session.agents?.stop("agent-1")).toBe(true);
    await expect(rewind()).resolves.toMatchObject({ outcome: "done" });
  });
});
