/**
 * Subagents in the mock engine (Phase 4, "Subagents"), scripted: a prompt that asks for an agent
 * ("Ask an agent to find the config loader") gets a turn whose reply calls the `Agent` tool, as
 * the real engine's model would, and an Explore agent that reads the project's README and
 * answers. With "background" in the prompt the agent runs in the background: the call returns at
 * once, the turn ends, and when the agent is done the engine starts a turn of its own to read the
 * result, as the real engine does.
 *
 * What a client sees is what the real engine sends:
 * - `subagent.updated` on the parent, whole each time: queued (first in line), running (its
 *   activity and tool uses), then completed with its final message;
 * - the agent's own session, never listed or opened, whose events `session.replay` returns:
 *   its prompt, a Read call and its answer;
 * - `subagent.stop`, which stops a queued or running agent.
 */
import type { SubagentInfo } from "@dawg/protocol";
import { ErrorCodes, RpcError } from "@dawg/protocol";
import type { MockClock } from "./api.ts";
import { IDLE, WORKING } from "./generate.ts";
import { Player, type Step, scaledDelay } from "./player.ts";
import { MockSession } from "./session.ts";

/** The prompt that asks for an agent: "agent" or "subagent" as a word. */
const AGENT_WORDS = /\b(sub)?agents?\b/i;
const BACKGROUND_WORDS = /\bbackground\b/i;

/** How the engine words the prompt of the turn it starts for a background agent that ended. */
export const BACKGROUND_AGENT_PROMPT = "Background agent";

const DESCRIPTION = "Find the config loader";
const AGENT_PROMPT =
  "Find where the project loads its configuration and report the file and the function.";
const ANSWER = [
  "The configuration is loaded in `README.md`'s setup section for this mock project:",
  "",
  "- **File:** `README.md`",
  "- **What it says:** settings come from the environment, then from `config.toml`.",
  "",
  "Nothing else in the project reads configuration.",
].join("\n");

interface AgentRun {
  info: SubagentInfo;
  /** The agent's own session: its log is what `session.replay` returns for it. */
  child: MockSession;
  /** Plays the agent's steps while it works (a background agent's; a foreground one's play in the parent's turn). */
  player: Player | null;
  /** The parent's call that started it, still waiting for the agent (foreground only). */
  waitingCall: { turnId: string; toolCallId: string } | null;
}

export interface AgentTurn {
  turnId: string;
  steps: Step[];
}

/** Whether a prompt asks for an agent. */
export function asksForAgent(text: string): boolean {
  return AGENT_WORDS.test(text);
}

export class MockAgents {
  readonly #clock: MockClock;
  readonly #speed: number;
  /** Agents by parent session id, then agent id. */
  readonly #runs = new Map<string, Map<string, AgentRun>>();
  /** Agents' own sessions, by their id, for `session.replay`. */
  readonly #children = new Map<string, MockSession>();
  /** Starts a turn in the parent for a background agent that ended (the engine plays it). */
  readonly #onBackgroundEnded: (parent: MockSession, prompt: string) => void;

  constructor(options: {
    clock: MockClock;
    speed: number;
    onBackgroundEnded(parent: MockSession, prompt: string): void;
  }) {
    this.#clock = options.clock;
    this.#speed = options.speed;
    this.#onBackgroundEnded = options.onBackgroundEnded;
  }

  /** An agent's own session, or undefined when the id is not one. */
  child(sessionId: string): MockSession | undefined {
    return this.#children.get(sessionId);
  }

  #delay(ms: number): number {
    return scaledDelay(ms, this.#speed);
  }

  /**
   * The turn for a prompt that asks for an agent: working and `turn.started` at once (so the
   * prompt's answer has the turn id), then the rest as steps.
   */
  turn(session: MockSession, text: string): AgentTurn {
    const background = BACKGROUND_WORDS.test(text);
    session.emit("session.status", { ...WORKING, message: "Working" });
    const turnId = session.ids.fresh("turn");
    session.emit("turn.started", {
      turnId,
      prompt: { content: [{ type: "text", text }], mentions: [] },
      command: null,
    });
    const messageId = session.ids.fresh("message");
    const toolCallId = session.ids.fresh("call");
    const intro = background
      ? "I'll have an Explore agent look for the config loader in the background."
      : "I'll ask an Explore agent to find the config loader.";
    const input = {
      description: DESCRIPTION,
      prompt: AGENT_PROMPT,
      subagent_type: "Explore",
      ...(background ? { run_in_background: true } : {}),
    };
    const run = this.#newRun(session, toolCallId, turnId, background);
    const steps: Step[] = [
      {
        delay: this.#delay(500),
        run: () => {
          session.emit("message.started", { turnId, messageId });
          session.emit("message.delta", { turnId, messageId, text: intro });
          session.emit("message.finished", {
            turnId,
            messageId,
            text: intro,
            reasoning: null,
            toolCalls: [{ toolCallId, toolName: "Agent" }],
          });
          session.emit("tool.started", {
            turnId,
            messageId,
            toolCallId,
            toolName: "Agent",
            input,
          });
          this.#update(session, run, { status: "queued", queuePosition: 1 });
        },
      },
    ];
    if (background) {
      steps.push({
        delay: this.#delay(200),
        run: () => {
          session.emit("tool.finished", {
            turnId,
            toolCallId,
            toolName: "Agent",
            outcome: "success",
            content: [{ type: "text", text: `Started in the background as ${run.info.agentId}.` }],
            display: null,
            durationMs: 200,
          });
          // The agent goes on by itself; the turn ends.
          run.player = new Player(this.#clock, this.#agentSteps(session, run), () => {
            run.player = null;
          });
          run.player.start();
        },
      });
      steps.push(...this.reply(session, turnId, "The agent is on it. I'll read what it finds."));
      return { turnId, steps };
    }
    run.waitingCall = { turnId, toolCallId };
    steps.push(...this.#agentSteps(session, run));
    steps.push({
      delay: 0,
      run: () => this.#finishCall(session, run),
    });
    steps.push(
      ...this.reply(
        session,
        turnId,
        "The Explore agent found it: settings come from the environment, then `config.toml`.",
      ),
    );
    return { turnId, steps };
  }

  /** `subagent.stop`. */
  stop(session: MockSession, agentId: string): { stopped: boolean } {
    const run = this.#runs.get(session.id)?.get(agentId);
    if (run === undefined) {
      throw new RpcError(ErrorCodes.InvalidParams, `There is no agent ${agentId} in this session.`);
    }
    if (run.info.status !== "queued" && run.info.status !== "running") return { stopped: false };
    run.player?.stop();
    run.player = null;
    this.#end(session, run, "stopped");
    const call = run.waitingCall;
    if (call !== null) {
      // The parent's turn waited on it: the call ends, then the turn.
      session.player?.stop();
      session.player = null;
      this.#finishCall(session, run);
      const steps = this.reply(session, call.turnId, "The agent was stopped before it finished.");
      for (const step of steps) step.run();
    }
    return { stopped: true };
  }

  /** The parent's turn was interrupted: an agent it waited on stops with it. */
  interrupted(session: MockSession): void {
    for (const run of this.#runs.get(session.id)?.values() ?? []) {
      if (run.waitingCall === null) continue;
      if (run.info.status === "queued" || run.info.status === "running") {
        this.#end(session, run, "stopped");
      }
      run.waitingCall = null;
    }
  }

  #newRun(session: MockSession, toolCallId: string, turnId: string, background: boolean): AgentRun {
    const runs = this.#runs.get(session.id) ?? new Map<string, AgentRun>();
    this.#runs.set(session.id, runs);
    const agentId = `agent-${runs.size + 1}`;
    const now = this.#clock.now();
    const child = new MockSession(
      {
        id: `${session.id}-${agentId}`,
        settings: { ...session.settings, title: DESCRIPTION, archived: false },
        createdAt: now,
      },
      { clock: this.#clock, onTurnEnded: () => {} },
    );
    this.#children.set(child.id, child);
    const run: AgentRun = {
      info: {
        agentId,
        sessionId: child.id,
        agentType: "Explore",
        description: DESCRIPTION,
        toolCallId,
        turnId,
        fork: false,
        background,
        status: "queued",
        queuePosition: 1,
        worktree: null,
        startedAt: now,
        endedAt: null,
        toolUses: 0,
        activity: null,
        result: null,
        error: null,
      },
      child,
      player: null,
      waitingCall: null,
    };
    runs.set(agentId, run);
    return run;
  }

  /** Sends the agent's whole state, changed by `changes`, on the parent. */
  #update(session: MockSession, run: AgentRun, changes: Partial<SubagentInfo>): void {
    run.info = { ...run.info, ...changes };
    session.emit("subagent.updated", { agent: run.info });
  }

  #end(session: MockSession, run: AgentRun, status: "completed" | "stopped"): void {
    const child = run.child;
    const turn = child.state.turn;
    if (status === "stopped" && turn !== null) {
      for (const [toolCallId, tool] of child.state.tools) {
        child.emit("tool.finished", {
          turnId: turn.turnId,
          toolCallId,
          toolName: tool.toolName,
          outcome: "interrupted",
          content: [{ type: "text", text: "Stopped before it finished." }],
          display: null,
          durationMs: null,
        });
      }
      child.emit("turn.finished", {
        turnId: turn.turnId,
        stopReason: "interrupted",
        finalText: null,
        error: null,
        durationMs: Math.max(0, this.#clock.now() - turn.startedAt),
      });
      child.emit("session.status", IDLE);
    }
    this.#update(session, run, {
      status,
      queuePosition: null,
      activity: null,
      endedAt: Math.max(run.info.startedAt, this.#clock.now()),
      result: status === "completed" ? ANSWER : null,
    });
  }

  /** The parent's call ends with the agent's answer (or the note that it stopped). */
  #finishCall(session: MockSession, run: AgentRun): void {
    const call = run.waitingCall;
    if (call === null) return;
    run.waitingCall = null;
    const completed = run.info.status === "completed";
    session.emit("tool.finished", {
      turnId: call.turnId,
      toolCallId: call.toolCallId,
      toolName: "Agent",
      outcome: completed ? "success" : "interrupted",
      content: [
        {
          type: "text",
          text: completed ? ANSWER : "The agent was stopped before it had a final message.",
        },
      ],
      display: null,
      durationMs: Math.max(0, this.#clock.now() - run.info.startedAt),
    });
  }

  /** What the agent does: takes a model slot, reads the README, answers. */
  #agentSteps(session: MockSession, run: AgentRun): Step[] {
    const child = run.child;
    const ids = child.ids;
    const cwd = session.settings.cwd;
    const turnId = ids.fresh("turn");
    const first = ids.fresh("message");
    const readId = ids.fresh("call");
    const second = ids.fresh("message");
    const file = `${cwd}/README.md`;
    const active = () => run.info.status === "queued" || run.info.status === "running";
    return [
      {
        delay: this.#delay(600),
        run: () => {
          if (!active()) return;
          this.#update(session, run, { status: "running", queuePosition: null });
          child.emit("session.status", { ...WORKING, message: "Working" });
          child.emit("turn.started", {
            turnId,
            prompt: { content: [{ type: "text", text: AGENT_PROMPT }], mentions: [] },
            command: null,
          });
        },
      },
      {
        delay: this.#delay(700),
        run: () => {
          if (!active()) return;
          child.emit("message.started", { turnId, messageId: first });
          child.emit("message.finished", {
            turnId,
            messageId: first,
            text: "",
            reasoning: null,
            toolCalls: [{ toolCallId: readId, toolName: "Read" }],
          });
          child.emit("tool.started", {
            turnId,
            messageId: first,
            toolCallId: readId,
            toolName: "Read",
            input: { file_path: file },
          });
          this.#update(session, run, { activity: "Read README.md", toolUses: 1 });
        },
      },
      {
        delay: this.#delay(500),
        run: () => {
          if (!active()) return;
          child.emit("tool.finished", {
            turnId,
            toolCallId: readId,
            toolName: "Read",
            outcome: "success",
            content: [
              {
                type: "text",
                text: "     1\t# Project\n     2\t\n     3\tSettings come from the environment, then from config.toml.\n",
              },
            ],
            display: null,
            durationMs: 12,
          });
          this.#update(session, run, { activity: "Writing its answer" });
        },
      },
      {
        delay: this.#delay(800),
        run: () => {
          if (!active()) return;
          child.emit("message.started", { turnId, messageId: second });
          child.emit("message.delta", { turnId, messageId: second, text: ANSWER });
          child.emit("message.finished", {
            turnId,
            messageId: second,
            text: ANSWER,
            reasoning: null,
            toolCalls: [],
          });
          child.emit("turn.finished", {
            turnId,
            stopReason: "completed",
            finalText: ANSWER,
            error: null,
            durationMs: Math.max(0, this.#clock.now() - run.info.startedAt),
          });
          child.emit("session.status", IDLE);
          this.#end(session, run, "completed");
          if (run.info.background) this.#onBackgroundEnded(session, backgroundPrompt(run.info));
        },
      },
    ];
  }

  /** A short closing reply, then the turn ends. */
  reply(session: MockSession, turnId: string, text: string): Step[] {
    const messageId = session.ids.fresh("message");
    return [
      {
        delay: this.#delay(400),
        run: () => {
          session.emit("message.started", { turnId, messageId });
          session.emit("message.delta", { turnId, messageId, text });
          session.emit("message.finished", {
            turnId,
            messageId,
            text,
            reasoning: null,
            toolCalls: [],
          });
          const now = this.#clock.now();
          session.emit("turn.finished", {
            turnId,
            stopReason: "completed",
            finalText: text,
            error: null,
            durationMs: Math.max(0, now - (session.state.turn?.startedAt ?? now)),
          });
          session.emit("session.status", IDLE);
        },
      },
    ];
  }
}

/** The prompt of the turn the engine starts when a background agent ends. */
function backgroundPrompt(agent: SubagentInfo): string {
  return [
    `${BACKGROUND_AGENT_PROMPT} ${agent.agentId} (${agent.agentType}: ${agent.description}) finished.`,
    "",
    agent.result ?? "It ended without a final message.",
  ].join("\n");
}
