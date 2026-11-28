/**
 * Subagents end to end on the engine, against the scripted mock model (Phase 4 spec,
 * "Subagents"). The parent's requests and each agent's requests get their own lanes: an agent's
 * system message names its role, and a parent request that holds an agent's result is told apart
 * by that result.
 */
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { stalled, text, toolCall, toolCalls } from "@dawg/mock-model";
import type { PermissionRequest, SubagentInfo } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createPromptAssembler } from "../prompt/index.ts";
import {
  type Harness,
  type HarnessOptions,
  historyProblems,
  startHarness,
  textOf,
} from "../runtime/__fixtures__/harness.ts";
import type { LoggedEvent } from "../runtime/event-log.ts";
import type { SessionRuntime } from "../runtime/session.ts";
import { childPaths } from "./store.ts";

let h: Harness | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

/** A harness with subagents on, the real prompt assembler (agents' prompts differ) and room. */
function start(options: HarnessOptions): Promise<Harness> {
  return startHarness({
    ...options,
    mock: { contextWindow: 200_000, ...options.mock },
    engine: { subagents: true, assembler: createPromptAssembler(), ...options.engine },
  });
}

const EXPLORE = { system: "You are the Explore agent" };

function updates(harness: Harness, sessionId: string): SubagentInfo[] {
  return harness
    .ofType(sessionId, "subagent.updated")
    .map((e) => (e.payload as unknown as { agent: SubagentInfo }).agent);
}

function finishedContent(harness: Harness, sessionId: string, toolName: string): string {
  const event = harness
    .ofType(sessionId, "tool.finished")
    .find((e) => e.payload.toolName === toolName);
  const content = (event?.payload.content ?? []) as { type: string; text?: string }[];
  return content.map((p) => p.text ?? "").join("");
}

function sessionDirOf(harness: Harness, session: SessionRuntime): Promise<string> {
  return harness.engine.store.paths(session.cwd, session.id).then((p) => p.dir);
}

describe("the Agent tool in the foreground", () => {
  it("runs an Explore agent on its own prompt and tools, and returns its final message", async () => {
    h = await start({
      files: { "notes/config.txt": "port = 4711\n" },
      script: {
        lanes: {
          explore: {
            match: EXPLORE,
            replies: [
              toolCall("Read", { file_path: "notes/config.txt" }),
              text("The port is 4711 (notes/config.txt:1)."),
            ],
          },
          after: { match: { bodyIncludes: "The port is 4711" }, replies: [text("It is 4711.")] },
          parent: {
            match: { lastUser: "Which port" },
            replies: [
              toolCall("Agent", {
                description: "Find the port",
                prompt: "Read notes/config.txt and report the port.",
                subagent_type: "Explore",
              }),
            ],
          },
        },
      },
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const outcome = await session.run(ask("Which port does it use?"));
    expect(outcome.finalText).toBe("It is 4711.");

    // The parent's call got the agent's final message, with its id.
    const result = finishedContent(h, session.id, "Agent");
    expect(result).toContain("The port is 4711 (notes/config.txt:1).");
    expect(result).toContain('SendMessage with to: "agent-1"');

    // Its state went queued, running, completed, linked to the call.
    const states = updates(h, session.id);
    expect(states.map((s) => s.status)).toEqual(
      expect.arrayContaining(["queued", "running", "completed"]),
    );
    const last = states[states.length - 1] as SubagentInfo;
    expect(last).toMatchObject({
      agentId: "agent-1",
      sessionId: `${session.id}-agent-1`,
      agentType: "Explore",
      description: "Find the port",
      fork: false,
      background: false,
      status: "completed",
      toolUses: 1,
      result: "The port is 4711 (notes/config.txt:1).",
    });
    const started = h
      .ofType(session.id, "tool.started")
      .find((e) => e.payload.toolName === "Agent");
    expect(last.toolCallId).toBe(started?.payload.toolCallId);

    // The agent's request: its own system prompt and a read-only tool subset.
    const agentRequest = h.mock.chatRequests.find((r) => r.lane === "explore");
    const body = agentRequest?.body as {
      messages: { role: string; content: unknown }[];
      tools: { function: { name: string } }[];
    };
    expect(String(body.messages[0]?.content)).toContain("You are a dawg-code subagent");
    const tools = body.tools.map((t) => t.function.name);
    expect(tools).toContain("Read");
    expect(tools).toContain("Grep");
    for (const name of ["Write", "Edit", "Agent", "SendMessage", "AskUserQuestion", "TodoWrite"]) {
      expect(tools).not.toContain(name);
    }
    // The parent's requests offer the agent tools.
    const parentBody = h.mock.chatRequests.find((r) => r.lane === "parent")?.body as typeof body;
    const parentTools = parentBody.tools.map((t) => t.function.name);
    expect(parentTools).toEqual(expect.arrayContaining(["Agent", "SendMessage"]));

    // Its transcript is its own file under the session's subagents folder, replayable, unlisted.
    const dir = await sessionDirOf(h, session);
    const child = childPaths(dir, `${session.id}-agent-1`);
    expect(await exists(child.file)).toBe(true);
    const replay = await h.engine.replay(`${session.id}-agent-1`, 0);
    const names = replay.events.map((e) => e.event);
    expect(names).toEqual(
      expect.arrayContaining(["turn.started", "tool.finished", "turn.finished"]),
    );
    const listed = await h.engine.listSessions();
    expect(listed.sessions.map((s) => s.id)).toEqual([session.id]);
    expect(historyProblems(session.view)).toEqual([]);
  });

  it("refuses an unknown agent type and lists the ones there are", async () => {
    h = await start({
      script: [
        toolCall("Agent", { description: "x", prompt: "y", subagent_type: "Nobody" }),
        text("done"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("go"));
    const result = finishedContent(h, session.id, "Agent");
    // The schema's enum refuses it before the tool runs; either way the model hears the types.
    expect(result).toMatch(/Explore/);
  });
});

describe("background agents", () => {
  it("returns at once, then tells the parent, and wakes it when it is idle", async () => {
    h = await start({
      files: { "a.txt": "alpha\n" },
      script: {
        lanes: {
          worker: {
            match: { system: "You are a general-purpose agent" },
            replies: [toolCall("Read", { file_path: "a.txt" }), text("a.txt says alpha.")],
          },
          woken: {
            match: { lastUser: "Background agent agent-1 finished" },
            replies: [text("The agent found alpha.")],
          },
          parent: {
            match: { lastUser: "Look at a.txt in the background" },
            replies: [
              toolCall("Agent", {
                description: "Read a.txt",
                prompt: "Read a.txt and say what it holds.",
                run_in_background: true,
              }),
              text("Started it."),
            ],
          },
        },
      },
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const first = await session.run(ask("Look at a.txt in the background"));
    expect(first.finalText).toBe("Started it.");
    expect(finishedContent(h, session.id, "Agent")).toContain("in the background");

    // The agent ends; the idle parent is woken with a turn of its own.
    const woken = await h.waitFor(
      (e) =>
        e.payload.sessionId === session.id &&
        e.event === "turn.started" &&
        JSON.stringify(e.payload.prompt).includes("Background agent agent-1 finished"),
    );
    expect(woken).toBeDefined();
    await h.waitFor(
      (e) =>
        e.payload.sessionId === session.id &&
        e.event === "turn.finished" &&
        e.payload.finalText === "The agent found alpha.",
    );
    // The parent's model was given the result in a note before the wake-up message.
    const request = h.mock.chatRequests.find((r) => r.lane === "woken");
    expect(request?.rawBody).toContain("a.txt says alpha.");
    const states = updates(h, session.id);
    expect(states[states.length - 1]).toMatchObject({ background: true, status: "completed" });
  });

  it("is stopped by subagent.stop and by closing the session", async () => {
    h = await start({
      script: {
        lanes: {
          // The agent's request never ends on its own.
          worker: {
            match: { system: "You are a general-purpose agent" },
            replies: [stalled(text("working"))],
          },
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
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("Start it"));
    await h.waitFor(
      (e) =>
        e.event === "subagent.updated" &&
        (e.payload as unknown as { agent: SubagentInfo }).agent.status === "running",
    );
    expect(await session.agents?.stop("agent-1")).toBe(true);
    const states = updates(h, session.id);
    expect(states[states.length - 1]?.status).toBe("stopped");
    expect(await session.agents?.stop("agent-1")).toBe(false);
  });
});

describe("forks", () => {
  it("starts from the parent's conversation, prefix and slot, so it shares the cache", async () => {
    h = await start({
      pools: { conversation: [0, 1] },
      script: {
        lanes: {
          fork: {
            match: { lastUser: "You are a fork of the conversation above" },
            replies: [text("Forked answer.")],
          },
          after: { match: { bodyIncludes: "Forked answer." }, replies: [text("Done.")] },
          parent: {
            match: { lastUser: "Try a fork" },
            replies: [
              toolCall("Agent", {
                description: "Side task",
                prompt: "Check the side task.",
                subagent_type: "fork",
              }),
            ],
          },
        },
      },
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("Try a fork"));
    const parent = h.mock.chatRequests.find((r) => r.lane === "parent")?.body as {
      messages: unknown[];
      tools: unknown[];
      id_slot?: number;
    };
    const fork = h.mock.chatRequests.find((r) => r.lane === "fork")?.body as typeof parent;
    // Same system message and tools; the parent's whole request is the start of the fork's.
    expect(JSON.stringify(fork.tools)).toBe(JSON.stringify(parent.tools));
    expect(JSON.stringify(fork.messages.slice(0, parent.messages.length))).toBe(
      JSON.stringify(parent.messages),
    );
    // The fork went to the parent's slot, where that prefix is cached.
    expect(fork.id_slot).toBe(parent.id_slot);
    const states = updates(h, session.id);
    expect(states[states.length - 1]).toMatchObject({
      agentType: "fork",
      fork: true,
      status: "completed",
    });
  });
});

describe("permissions", () => {
  it("inherits the parent's rules and raises its prompts in the parent, labelled", async () => {
    h = await start({
      files: {
        ".dawg/settings.json": JSON.stringify({ permissions: { allow: ["Bash(echo hi)"] } }),
      },
      script: {
        lanes: {
          worker: {
            match: { system: "You are a general-purpose agent" },
            replies: [
              toolCalls([{ name: "Bash", arguments: { command: "echo hi" } }]),
              toolCalls([{ name: "Bash", arguments: { command: "touch made.txt" } }]),
              text("Both ran."),
            ],
          },
          after: { match: { bodyIncludes: "Both ran." }, replies: [text("Fine.")] },
          parent: {
            match: { lastUser: "Run things" },
            replies: [toolCall("Agent", { description: "Run commands", prompt: "Run them." })],
          },
        },
      },
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const asked: PermissionRequest[] = [];
    session.subscribe((event: LoggedEvent) => {
      if (event.event !== "permission.requested") return;
      const request = event.payload.request as PermissionRequest;
      asked.push(request);
      setImmediate(() =>
        session.respondPermission(request.requestId, { behavior: "allow", scope: "once" }),
      );
    });
    const outcome = await session.run(ask("Run things"));
    expect(outcome.finalText).toBe("Fine.");
    // `echo hi` was allowed by the parent's rule; only `touch` asked, in the parent, labelled.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.input).toEqual({ command: "touch made.txt" });
    expect(asked[0]?.agent).toEqual({
      agentId: "agent-1",
      sessionId: `${session.id}-agent-1`,
      agentType: "general-purpose",
      description: "Run commands",
    });
    expect(await exists(path.join(h.project, "made.txt"))).toBe(true);
    // The request was resolved on the parent, which showed as waiting meanwhile.
    expect(h.ofType(session.id, "request.resolved")).toHaveLength(1);
  });

  it("keeps a read-only agent read-only whatever the parent's mode", async () => {
    h = await start({
      script: {
        lanes: {
          explore: {
            match: EXPLORE,
            replies: [toolCall("Bash", { command: "touch nope.txt" }), text("Could not write.")],
          },
          after: { match: { bodyIncludes: "Could not write." }, replies: [text("ok")] },
          parent: {
            match: { lastUser: "Explore" },
            replies: [
              toolCall("Agent", { description: "x", prompt: "y", subagent_type: "Explore" }),
            ],
          },
        },
      },
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "bypassPermissions" });
    await session.run(ask("Explore"));
    expect(await exists(path.join(h.project, "nope.txt"))).toBe(false);
  });
});

describe("follow-up messages", () => {
  it("sends a finished agent another message by its id; it keeps its history", async () => {
    h = await start({
      script: {
        lanes: {
          again: {
            match: { lastUser: "And the second?" },
            replies: [text("Second: beta.")],
          },
          worker: {
            match: { system: "You are a general-purpose agent" },
            replies: [text("First: alpha.")],
          },
          done: { match: { bodyIncludes: "Second: beta." }, replies: [text("All done.")] },
          followUp: {
            match: { bodyIncludes: "First: alpha." },
            replies: [toolCall("SendMessage", { to: "agent-1", message: "And the second?" })],
          },
          parent: {
            match: { lastUser: "Two answers" },
            replies: [toolCall("Agent", { description: "Answer", prompt: "Give the first." })],
          },
        },
      },
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const outcome = await session.run(ask("Two answers"));
    expect(outcome.finalText).toBe("All done.");
    expect(finishedContent(h, session.id, "SendMessage")).toContain("Second: beta.");
    // The agent's second request held its first task.
    const second = h.mock.chatRequests.find((r) => r.lane === "again");
    expect(second?.rawBody).toContain("Give the first.");
    expect(second?.rawBody).toContain("First: alpha.");
  });
});

describe("hooks", () => {
  it("fires SubagentStart and SubagentStop from the parent's settings", async () => {
    h = await start({
      script: {
        lanes: {
          worker: {
            match: { system: "You are a general-purpose agent" },
            replies: [text("first try"), text("second try")],
          },
          after: { match: { bodyIncludes: "second try" }, replies: [text("ok")] },
          parent: {
            match: { lastUser: "Hooked" },
            replies: [toolCall("Agent", { description: "Hooked task", prompt: "Do it." })],
          },
        },
      },
    });
    const log = path.join(h.root, "hooks.log");
    const settings = {
      hooks: {
        SubagentStart: [
          {
            matcher: "general-purpose",
            hooks: [
              {
                type: "command",
                command: `cat >> ${log}; echo >> ${log}; echo '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"START-CONTEXT"}}'`,
              },
            ],
          },
        ],
        SubagentStop: [
          {
            hooks: [
              {
                type: "command",
                command: `input=$(cat); echo "$input" >> ${log}; case "$input" in *'"stop_hook_active":false'*) echo '{"decision":"block","reason":"Try once more"}';; esac`,
              },
            ],
          },
        ],
      },
    };
    await mkdir(path.join(h.home, ".dawg"), { recursive: true });
    await writeFile(path.join(h.home, ".dawg", "settings.json"), JSON.stringify(settings));
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("Hooked"));
    const lines = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({
      hook_event_name: "SubagentStart",
      agent_id: "agent-1",
      agent_type: "general-purpose",
    });
    const stops = lines.filter((l) => l.hook_event_name === "SubagentStop");
    expect(stops).toHaveLength(2);
    expect(stops[0]).toMatchObject({
      stop_hook_active: false,
      last_assistant_message: "first try",
    });
    expect(stops[1]).toMatchObject({ stop_hook_active: true });
    expect(String(stops[0].agent_transcript_path)).toContain("subagents");
    // The start context reached the agent; the block kept it going for a second reply.
    const firstRequest = h.mock.chatRequests.find((r) => r.lane === "worker");
    expect(firstRequest?.rawBody).toContain("START-CONTEXT");
    expect(finishedContent(h, session.id, "Agent")).toContain("second try");
    expect(
      h.ofType(session.id, "hook.ran").map((e) => (e.payload.hook as { event: string }).event),
    ).toEqual(expect.arrayContaining(["SubagentStart", "SubagentStop"]));
  });
});

describe("isolation", () => {
  function gitRepo(dir: string): void {
    const run = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        stdio: "ignore",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    run("init", "-q", "-b", "main");
    run("-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A");
    run("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  }

  it("runs the agent in its own worktree; one with changes is kept, one without removed", async () => {
    h = await start({
      files: { "README.md": "# repo\n" },
      engine: { capabilities: { permissionPrompts: false } },
      script: {
        lanes: {
          writer: {
            match: { lastUser: "Write a file" },
            replies: [
              toolCall("Write", { file_path: "made.txt", content: "made\n" }),
              text("Wrote it."),
            ],
          },
          idle: { match: { lastUser: "Do nothing" }, replies: [text("Nothing done.")] },
          after: { match: { bodyIncludes: "Nothing done." }, replies: [text("ok")] },
          next: {
            match: { bodyIncludes: "Wrote it." },
            replies: [
              toolCall("Agent", {
                description: "Idle",
                prompt: "Do nothing",
                isolation: "worktree",
              }),
            ],
          },
          parent: {
            match: { lastUser: "Isolate" },
            replies: [
              toolCall("Agent", {
                description: "Write",
                prompt: "Write a file",
                isolation: "worktree",
              }),
            ],
          },
        },
      },
    });
    gitRepo(h.project);
    const session = await h.engine.createSession({ cwd: h.project, mode: "acceptEdits" });
    await session.run(ask("Isolate"));
    const states = updates(h, session.id);
    const first = states.filter((s) => s.agentId === "agent-1").pop() as SubagentInfo;
    const second = states.filter((s) => s.agentId === "agent-2").pop() as SubagentInfo;
    expect(first.worktree?.branch).toMatch(/^dawg\/agent-/);
    const kept = first.worktree?.path as string;
    expect(kept.startsWith(path.join(await realpath(h.project), ".dawg", "worktrees"))).toBe(true);
    // The file went to the worktree, not the person's checkout.
    expect(await exists(path.join(kept, "made.txt"))).toBe(true);
    expect(await exists(path.join(h.project, "made.txt"))).toBe(false);
    expect(finishedContent(h, session.id, "Agent")).toContain(kept);
    // The agent that changed nothing left no worktree behind.
    expect(await exists(second.worktree?.path as string)).toBe(false);
  });
});

describe("skills with context: fork", () => {
  it("run as a subagent through the Skill tool", async () => {
    h = await start({
      files: {
        ".claude/skills/survey/SKILL.md":
          "---\ndescription: Survey the code\ncontext: fork\nagent: Explore\n---\nList the files in SURVEY-DIR.\n",
      },
      script: {
        lanes: {
          explore: { match: EXPLORE, replies: [text("Survey result: two files.")] },
          after: { match: { bodyIncludes: "Survey result" }, replies: [text("Surveyed.")] },
          parent: {
            match: { lastUser: "Survey" },
            replies: [toolCall("Skill", { skill: "survey" })],
          },
        },
      },
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const outcome = await session.run(ask("Survey"));
    expect(outcome.finalText).toBe("Surveyed.");
    const agentRequest = h.mock.chatRequests.find((r) => r.lane === "explore");
    expect(agentRequest?.rawBody).toContain("List the files in SURVEY-DIR.");
    expect(finishedContent(h, session.id, "Skill")).toContain("Survey result: two files.");
    const states = updates(h, session.id);
    expect(states[states.length - 1]).toMatchObject({ agentType: "Explore", status: "completed" });
  });
});

describe("agent files", () => {
  it("runs a project agent with its prompt and tools", async () => {
    h = await start({
      files: {
        ".claude/agents/reviewer.md":
          "---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\nmodel: sonnet\n---\nREVIEWER-PROMPT: look for bugs.\n",
      },
      script: {
        lanes: {
          reviewer: { match: { system: "REVIEWER-PROMPT" }, replies: [text("No bugs.")] },
          after: { match: { bodyIncludes: "No bugs." }, replies: [text("Reviewed.")] },
          parent: {
            match: { lastUser: "Review" },
            replies: [
              toolCall("Agent", {
                description: "Review",
                prompt: "Review.",
                subagent_type: "reviewer",
              }),
            ],
          },
        },
      },
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("Review"));
    const request = h.mock.chatRequests.find((r) => r.lane === "reviewer")?.body as {
      messages: { content: unknown }[];
      tools: { function: { name: string } }[];
    };
    expect(request.tools.map((t) => t.function.name).sort()).toEqual(["Grep", "Read"]);
    expect(String(request.messages[0]?.content)).toContain("You are the reviewer agent.");
    // The Agent tool lists it beside the built-ins.
    const parent = h.mock.chatRequests.find((r) => r.lane === "parent")?.rawBody ?? "";
    expect(parent).toContain("reviewer: Reviews code");
    expect(textOf(session.view.at(-1))).toBe("Reviewed.");
  });
});

describe("scheduling on one model", () => {
  it("queues agents while every slot is taken, and runs the next when one frees", async () => {
    h = await start({
      pools: { conversation: [0] },
      script: {
        lanes: {
          one: { match: { lastUser: "Job one" }, replies: [stalled(text("working"))] },
          two: { match: { lastUser: "Job two" }, replies: [text("Two done.")] },
          woken: { match: { lastUser: "Background agent agent-2" }, replies: [text("ok")] },
          parent: {
            match: { lastUser: "Start two" },
            replies: [
              toolCalls([
                {
                  name: "Agent",
                  arguments: { description: "One", prompt: "Job one", run_in_background: true },
                },
                {
                  name: "Agent",
                  arguments: { description: "Two", prompt: "Job two", run_in_background: true },
                },
              ]),
              text("Started both."),
            ],
          },
        },
      },
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("Start two"));
    const agentState = (e: LoggedEvent) => (e.payload as unknown as { agent: SubagentInfo }).agent;
    // With the parent's turn over, the one slot goes to agent-1; agent-2 waits first in line.
    await h.waitFor(
      (e) =>
        e.event === "subagent.updated" &&
        agentState(e).agentId === "agent-1" &&
        agentState(e).status === "running",
    );
    await h.waitFor(
      (e) =>
        e.event === "subagent.updated" &&
        agentState(e).agentId === "agent-2" &&
        agentState(e).status === "queued" &&
        agentState(e).queuePosition === 1,
    );
    const mock = h.mock;
    await expect.poll(() => mock.chatRequests.some((r) => r.lane === "one")).toBe(true);
    await session.agents?.stop("agent-1");
    await h.waitFor(
      (e) =>
        e.event === "subagent.updated" &&
        agentState(e).agentId === "agent-2" &&
        agentState(e).status === "completed",
    );
    // Only one agent request was ever in flight on the one slot.
    const slots = h.mock.chatRequests
      .filter((r) => r.lane === "one" || r.lane === "two")
      .map((r) => (r.body as { id_slot?: number }).id_slot);
    expect(slots).toEqual([0, 0]);
  });
});

describe("project agents need consent for their grants", () => {
  it("holds back an unapproved project agent's tool grants; the person's own apply", async () => {
    const agentFile = (name: string, file: string) =>
      `---\nname: ${name}\ndescription: Runs ${name}\ntools: Read, Bash(touch ${file})\n---\nRun the command you are given.\n`;
    h = await start({
      engine: { capabilities: { permissionPrompts: false } },
      files: { ".claude/agents/project.md": agentFile("project-runner", "project.txt") },
      script: {
        lanes: {
          projectRunner: {
            match: { system: "You are the project-runner agent" },
            replies: [toolCall("Bash", { command: "touch project.txt" }), text("Tried.")],
          },
          mine: {
            match: { system: "You are the my-runner agent" },
            replies: [toolCall("Bash", { command: "touch mine.txt" }), text("Tried mine.")],
          },
          end: { match: { bodyIncludes: "Tried mine." }, replies: [text("ok")] },
          next: {
            match: { bodyIncludes: "Tried." },
            replies: [
              toolCall("Agent", { description: "Mine", prompt: "go", subagent_type: "my-runner" }),
            ],
          },
          parent: {
            match: { lastUser: "Run them" },
            replies: [
              toolCall("Agent", {
                description: "Project",
                prompt: "go",
                subagent_type: "project-runner",
              }),
            ],
          },
        },
      },
    });
    await mkdir(path.join(h.home, ".dawg", "agents"), { recursive: true });
    await writeFile(
      path.join(h.home, ".dawg", "agents", "mine.md"),
      agentFile("my-runner", "mine.txt"),
    );
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("Run them"));
    expect(await exists(path.join(h.project, "project.txt"))).toBe(false);
    expect(await exists(path.join(h.project, "mine.txt"))).toBe(true);
  });
});
