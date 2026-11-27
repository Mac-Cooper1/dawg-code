import type { SubagentInfo } from "@dawg/protocol";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { AgentCard } from "./AgentCard.tsx";
import { agentHasOutcome, agentMessage, isAgentCall } from "./agentInfo.ts";
import { Transcript } from "./Transcript.tsx";
import { makeEnv, makeProps, makeView, toolItem } from "./testing.ts";
import { defaultToolOpen } from "./toolInfo.ts";

const T0 = 1_763_800_000_000;

function agent(overrides: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    agentId: "agent-1",
    sessionId: "session-1-agent-1",
    agentType: "Explore",
    description: "Find the config loader",
    toolCallId: "call-1",
    turnId: "turn-1",
    fork: false,
    background: false,
    status: "running",
    queuePosition: null,
    worktree: null,
    startedAt: T0,
    endedAt: null,
    toolUses: 3,
    activity: "Read src/config.ts",
    result: null,
    error: null,
    ...overrides,
  };
}

function agentItem(info: SubagentInfo | undefined, overrides = {}) {
  return toolItem({
    id: "tool:call-1",
    toolCallId: "call-1",
    toolName: "Agent",
    input: {
      description: "Find the config loader",
      prompt: "Find where the config is loaded",
      subagent_type: "Explore",
    },
    state: "running",
    content: null,
    display: null,
    ...(info ? { agent: info } : {}),
    ...overrides,
  });
}

const ANSWER = "The config is loaded by `loadConfig` in **src/config.ts**.";

describe.each(THEMES)("AgentCard (%s)", (theme) => {
  it("shows a queued agent with its place in line", () => {
    renderInTheme(
      <AgentCard
        item={agentItem(agent({ status: "queued", queuePosition: 2, activity: null, toolUses: 0 }))}
        open={false}
        env={makeEnv({ openSubagent: vi.fn() })}
      />,
      theme,
    );
    expect(screen.getByText("Explore agent")).toBeInTheDocument();
    expect(screen.getByText("Find the config loader")).toBeInTheDocument();
    expect(screen.getByText("Queued · 2nd in line for the model")).toBeInTheDocument();
  });

  it("shows a running agent's activity and tool uses, and opens its transcript", () => {
    const openSubagent = vi.fn();
    renderInTheme(
      <AgentCard item={agentItem(agent())} open={false} env={makeEnv({ openSubagent })} />,
      theme,
    );
    expect(screen.getByText("Running · Read src/config.ts · 3 tool uses")).toBeInTheDocument();
    const header = screen.getByRole("button", { name: /^Explore agent: Find the config loader/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open the transcript of Explore agent: Find the config loader",
      }),
    );
    expect(openSubagent).toHaveBeenCalledWith("agent-1");
  });

  it("shows a completed agent's final message as Markdown", () => {
    const item = agentItem(
      agent({ status: "completed", endedAt: T0 + 12_000, result: ANSWER, toolUses: 5 }),
      { state: "success", content: [{ type: "text", text: ANSWER }] },
    );
    renderInTheme(<AgentCard item={item} open env={makeEnv()} />, theme);
    expect(screen.getByText(/^Done · 5 tool uses · 12/)).toBeInTheDocument();
    const code = screen.getByText("loadConfig");
    expect(code.tagName).toBe("CODE");
    expect(screen.getByText("src/config.ts").tagName).toBe("STRONG");
    // Nowhere to show the transcript (inside an agent's own): no button.
    expect(screen.queryByRole("button", { name: /^Open the transcript/ })).toBeNull();
  });

  it("shows a failed agent's error", () => {
    const item = agentItem(
      agent({
        status: "failed",
        endedAt: T0 + 2_000,
        error: {
          kind: "model_unavailable",
          message: "The model stopped responding.",
          detail: null,
          retryable: true,
        },
      }),
      { state: "error", content: [{ type: "text", text: "The agent failed" }] },
    );
    renderInTheme(<AgentCard item={item} open env={makeEnv()} />, theme);
    expect(screen.getByText("Failed: The model stopped responding")).toBeInTheDocument();
    expect(screen.getByText("The model stopped responding.")).toBeInTheDocument();
  });

  it("shows a stopped agent, and how a background agent in a worktree runs", () => {
    renderInTheme(
      <AgentCard
        item={agentItem(
          agent({
            status: "stopped",
            endedAt: T0 + 4_000,
            background: true,
            worktree: { path: "/tmp/w", branch: "dawg/agent-1" },
          }),
          { state: "success", content: [{ type: "text", text: "Started in the background." }] },
        )}
        open
        env={makeEnv()}
      />,
      theme,
    );
    expect(screen.getByText(/^Stopped · 3 tool uses/)).toBeInTheDocument();
    expect(
      screen.getByText("In the background · In a worktree on dawg/agent-1"),
    ).toBeInTheDocument();
    // The call's note is not the agent's answer.
    expect(screen.queryByText("Started in the background.")).toBeNull();
    expect(screen.getByText("It stopped before it had a final message.")).toBeInTheDocument();
  });

  it("names the agent from the call before the engine reports it", () => {
    renderInTheme(<AgentCard item={agentItem(undefined)} open={false} env={makeEnv()} />, theme);
    expect(screen.getByText("Explore agent")).toBeInTheDocument();
    expect(screen.getByText("Starting…")).toBeInTheDocument();
  });

  it("is what the transcript draws for Agent, SendMessage and a forked Skill", () => {
    const send = toolItem({
      id: "tool:call-2",
      toolCallId: "call-2",
      toolName: "SendMessage",
      input: { to: "agent-1", message: "Now the tests" },
      agent: agent({ toolCallId: "call-2" }),
    });
    const skill = toolItem({
      id: "tool:call-3",
      toolCallId: "call-3",
      toolName: "Skill",
      input: { skill: "deep-review" },
      agent: agent({ agentId: "agent-2", agentType: "fork", description: "deep-review" }),
    });
    const props = makeProps({
      view: makeView({ items: [agentItem(agent()), send, skill] }),
      onOpenSubagent: vi.fn(),
    });
    renderInTheme(<Transcript {...props} />, theme);
    const log = screen.getByRole("log", { name: "Transcript" });
    expect(within(log).getAllByText("Explore agent")).toHaveLength(2);
    expect(within(log).getByText("Forked agent")).toBeInTheDocument();
    fireEvent.click(
      within(log).getByRole("button", { name: "Open the transcript of Forked agent: deep-review" }),
    );
    expect(props.onOpenSubagent).toHaveBeenCalledWith("agent-2");
  });
});

describe("agent card rules", () => {
  it("draws Agent and SendMessage calls, and any call an agent runs for, as agent cards", () => {
    expect(isAgentCall(agentItem(undefined))).toBe(true);
    expect(isAgentCall(toolItem({ toolName: "SendMessage" }))).toBe(true);
    expect(isAgentCall(toolItem({ toolName: "Skill" }))).toBe(false);
    expect(isAgentCall(toolItem({ toolName: "Skill", agent: agent() }))).toBe(true);
  });

  it("opens once there is a final message or an error, in smart mode", () => {
    const running = agentItem(agent());
    const done = agentItem(agent({ status: "completed", result: ANSWER }), { state: "success" });
    const background = agentItem(agent({ background: true }), {
      state: "success",
      content: [{ type: "text", text: "Started in the background as agent-1." }],
    });
    expect(defaultToolOpen(running, "smart")).toBe(false);
    expect(defaultToolOpen(done, "smart")).toBe(true);
    expect(defaultToolOpen(background, "smart")).toBe(false);
    expect(agentMessage(background)).toBeNull();
    expect(agentHasOutcome(agentItem(agent({ status: "failed" })))).toBe(true);
    expect(defaultToolOpen(done, "closed")).toBe(false);
  });
});
