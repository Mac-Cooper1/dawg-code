/**
 * The parts of subagents that need no model: seats on one model's slots, the built-ins' tool
 * subsets, the mode an agent runs in, and agent files turned into agents.
 */
import { defineAgent, emptyAgent } from "@dawg/compat";
import type { PermissionMode } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import type { AnyTool } from "../contracts/tools.ts";
import { CORE_TOOLS, WEB_TOOLS } from "../tools/index.ts";
import { INTERACTIVE_TOOLS } from "../tools/interactive/index.ts";
import { activityOf } from "./manager.ts";
import { AgentRegistry, type AgentSpec, agentMode, agentTools } from "./registry.ts";
import { AgentSeats } from "./seats.ts";
import { childSessionId, parentOfChild } from "./store.ts";

const ALL: readonly AnyTool[] = [
  ...CORE_TOOLS,
  ...INTERACTIVE_TOOLS,
  ...WEB_TOOLS,
  { name: "Agent" } as AnyTool,
  { name: "SendMessage" } as AnyTool,
];

const names = (tools: readonly AnyTool[]) => tools.map((t) => t.name);

describe("seats on the model's conversation slots", () => {
  /** Admits an agent and reports whether it got a seat at once. */
  async function admitted(
    seats: AgentSeats,
    owner: string,
  ): Promise<{
    seated: boolean;
    release(): void;
    position: number | null;
    wait: Promise<unknown>;
  }> {
    let position: number | null = null;
    let seated = false;
    let release = () => {};
    const wait = seats
      .admit({
        owner,
        onQueue: (p) => {
          position = p;
        },
      })
      .then((seat) => {
        seated = true;
        release = () => seat.release();
      });
    await Promise.resolve();
    await Promise.resolve();
    return {
      get seated() {
        return seated;
      },
      release: () => release(),
      get position() {
        return position;
      },
      wait,
    };
  }

  it("with one slot: an agent queues while its parent's turn runs, and runs in its place", async () => {
    const seats = new AgentSeats(1);
    seats.setActive("parent", true);
    const a = await admitted(seats, "a");
    expect(a.seated).toBe(false);
    expect(a.position).toBe(1);
    // The parent waits on a foreground agent: its seat is lent.
    const giveBack = seats.lend("parent");
    await a.wait;
    expect(a.seated).toBe(true);
    const b = await admitted(seats, "b");
    expect(b.seated).toBe(false);
    a.release();
    await b.wait;
    expect(b.seated).toBe(true);
    b.release();
    giveBack();
    seats.setActive("parent", false);
    // An idle parent leaves the slot to its background agents.
    const c = await admitted(seats, "c");
    expect(c.seated).toBe(true);
  });

  it("with two slots: the main conversation and one agent, or two agents while it waits", async () => {
    const seats = new AgentSeats(2);
    seats.setActive("parent", true);
    const a = await admitted(seats, "a");
    const b = await admitted(seats, "b");
    expect([a.seated, b.seated]).toEqual([true, false]);
    expect(b.position).toBe(1);
    const giveBack = seats.lend("parent");
    await b.wait;
    expect(b.seated).toBe(true);
    giveBack();
    // The parent takes its seat back; a third agent waits for one of the two.
    const c = await admitted(seats, "c");
    expect(c.seated).toBe(false);
    a.release();
    // Still full: the parent's seat and b's.
    await Promise.resolve();
    expect(c.seated).toBe(false);
    b.release();
    await c.wait;
    expect(c.seated).toBe(true);
  });

  it("with three slots: two agents beside the main conversation, the rest in line, in order", async () => {
    const seats = new AgentSeats(3);
    seats.setActive("parent", true);
    const a = await admitted(seats, "a");
    const b = await admitted(seats, "b");
    const c = await admitted(seats, "c");
    const d = await admitted(seats, "d");
    expect([a.seated, b.seated, c.seated, d.seated]).toEqual([true, true, false, false]);
    expect([c.position, d.position]).toEqual([1, 2]);
    expect(seats.waiting).toBe(2);
    b.release();
    await c.wait;
    expect(c.seated).toBe(true);
    // d moved up to first in line.
    expect(d.position).toBe(1);
  });

  it("stops a queued agent at once when its wait is aborted", async () => {
    const seats = new AgentSeats(1);
    seats.setActive("parent", true);
    const controller = new AbortController();
    const wait = seats.admit({ owner: "a", signal: controller.signal });
    controller.abort();
    await expect(wait).rejects.toThrow(/stopped while it waited/);
    expect(seats.waiting).toBe(0);
  });
});

describe("the built-in agents", () => {
  const registry = new AgentRegistry([]);
  const spec = (name: string) => registry.find(name) as AgentSpec;

  it("lists Explore, Plan and general-purpose", () => {
    expect(registry.names).toEqual(["Explore", "Plan", "general-purpose"]);
  });

  it("gives Explore and Plan only tools that read, and general-purpose every subagent tool", () => {
    for (const name of ["Explore", "Plan"]) {
      const tools = names(agentTools(spec(name), ALL));
      expect(tools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Bash", "WebFetch"]));
      for (const missing of [
        "Write",
        "Edit",
        "TodoWrite",
        "Agent",
        "SendMessage",
        "AskUserQuestion",
        "ExitPlanMode",
      ]) {
        expect(tools).not.toContain(missing);
      }
    }
    const general = names(agentTools(spec("general-purpose"), ALL));
    expect(general).toEqual(expect.arrayContaining(["Read", "Write", "Edit", "Bash", "TodoWrite"]));
    for (const missing of [
      "Agent",
      "SendMessage",
      "AskUserQuestion",
      "EnterPlanMode",
      "ExitPlanMode",
    ]) {
      expect(general).not.toContain(missing);
    }
  });

  it("runs Explore and Plan in plan mode whatever the parent's mode", () => {
    for (const parent of [
      "default",
      "acceptEdits",
      "bypassPermissions",
      "dontAsk",
    ] as PermissionMode[]) {
      expect(
        agentMode({ parent, spec: spec("Explore"), approved: true, allowed: () => true }),
      ).toBe("plan");
    }
  });
});

describe("agent files", () => {
  const source = {
    path: "/p/.claude/agents/x.md",
    origin: "claude" as const,
    scope: "project" as const,
  };
  const define = (fields: Record<string, unknown>, body = "Prompt.") =>
    defineAgent(emptyAgent(source.path, source), { name: "x", description: "X", ...fields }, body);

  it("narrows tools, takes away disallowed ones, and keeps the session's order", () => {
    const registry = new AgentRegistry([
      define({ tools: "Grep, Read, Bash(npm test *)", disallowedTools: ["Bash"] }),
    ]);
    const spec = registry.find("x") as AgentSpec;
    expect(names(agentTools(spec, ALL))).toEqual(["Read", "Grep"]);
    expect(spec.grants).toEqual(["Bash(npm test *)"]);
    expect(spec.projectCode).toBe(true);
    // A file named like a built-in takes its place; the rest follow the built-ins.
    const replaced = new AgentRegistry([{ ...define({}), name: "Explore" }, define({})]);
    expect(replaced.names).toEqual(["Explore", "Plan", "general-purpose", "x"]);
    expect(replaced.find("Explore")?.readOnly).toBe(false);
  });

  it("follows the documented mode precedence, and holds back a looser mode until approved", () => {
    const loose = new AgentRegistry([define({ permissionMode: "acceptEdits" })]).find(
      "x",
    ) as AgentSpec;
    const strict = new AgentRegistry([define({ permissionMode: "plan" })]).find("x") as AgentSpec;
    const mode = (parent: PermissionMode, spec: AgentSpec, approved = true, allowed = true) =>
      agentMode({ parent, spec, approved, allowed: () => allowed });
    // A parent in bypass or acceptEdits keeps its mode; one in plan mode keeps its agents there.
    expect(mode("bypassPermissions", strict)).toBe("bypassPermissions");
    expect(mode("acceptEdits", strict)).toBe("acceptEdits");
    expect(mode("plan", loose)).toBe("plan");
    // Otherwise the agent's own mode applies...
    expect(mode("default", strict)).toBe("plan");
    expect(mode("default", loose)).toBe("acceptEdits");
    expect(mode("dontAsk", loose)).toBe("acceptEdits");
    // ...unless it is project code not approved yet and looser, or settings turn it off.
    expect(mode("default", loose, false)).toBe("default");
    expect(mode("default", strict, false)).toBe("plan");
    expect(mode("default", loose, true, false)).toBe("default");
  });
});

describe("names and lines", () => {
  it("gives a subagent's session an id that leads back to its parent", () => {
    const id = childSessionId("0193a7c2-1111-7000-8000-000000000000", 3);
    expect(parentOfChild(id)).toEqual({
      parentId: "0193a7c2-1111-7000-8000-000000000000",
      number: 3,
    });
    expect(parentOfChild("0193a7c2-1111-7000-8000-000000000000")).toBeNull();
  });

  it("describes an agent's tool calls in one line", () => {
    expect(activityOf("Read", { file_path: "/p/src/app.ts" }, "/p")).toBe("Read src/app.ts");
    expect(activityOf("Bash", { command: "npm  test\n--watch" }, "/p")).toBe(
      "Bash npm test --watch",
    );
    expect(activityOf("TodoWrite", { todos: [] }, "/p")).toBe("TodoWrite");
  });
});
