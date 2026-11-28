/** Subagent definitions in the mock engine, answered as the real engine answers them. */
import { ErrorCodes, RpcError } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, HOME, harness } from "./test-support.ts";

let h: Harness;
afterEach(() => h?.engine.dispose());

const TALLY = `${HOME}/code/tally`;

async function connected() {
  h = harness({ speed: Number.POSITIVE_INFINITY });
  return h.connect();
}

describe("project.subagents", () => {
  it("lists the built-ins, the person's files and the project's, with their statuses", async () => {
    const peer = await connected();
    const { agents, folders } = await peer.request("project.subagents", { projectDir: TALLY });
    expect(agents.map((a) => [a.name, a.builtIn ? "builtin" : a.source?.scope, a.status])).toEqual([
      ["Explore", "builtin", "loaded"],
      ["Plan", "builtin", "loaded"],
      ["general-purpose", "builtin", "loaded"],
      ["release-notes", "user", "loaded"],
      ["test-runner", "user", "overridden"],
      ["code-reviewer", "project", "needs-approval"],
      ["designer", "project", "invalid"],
      ["test-runner", "project", "loaded"],
    ]);
    expect(folders).toEqual({ user: `${HOME}/.dawg/agents`, project: `${TALLY}/.dawg/agents` });
    const alone = await peer.request("project.subagents", { projectDir: null });
    expect(alone.agents.some((a) => a.source?.scope === "project")).toBe(false);
    expect(alone.folders.project).toBeNull();
  });
});

describe("subagent.create", () => {
  it("adds the new agent to the listing, and refuses a bad name or a file already there", async () => {
    const peer = await connected();
    const made = await peer.request("subagent.create", {
      projectDir: TALLY,
      scope: "user",
      name: "checker",
      description: "Checks things",
      memory: "user",
    });
    expect(made.path).toBe(`${HOME}/.dawg/agents/checker.md`);
    expect(made.agent).toMatchObject({
      memory: "user",
      memoryDirectory: `${HOME}/.dawg/agent-memory/checker`,
    });
    const { agents } = await peer.request("project.subagents", { projectDir: null });
    expect(agents.find((a) => a.name === "checker")?.source?.path).toBe(made.path);

    const again = peer.request("subagent.create", {
      projectDir: null,
      scope: "user",
      name: "checker",
      description: "Again",
    });
    await expect(again).rejects.toBeInstanceOf(RpcError);
    await expect(again).rejects.toMatchObject({ code: ErrorCodes.InvalidState });
    await expect(
      peer.request("subagent.create", {
        projectDir: null,
        scope: "user",
        name: "Bad Name",
        description: "X",
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    await expect(
      peer.request("subagent.create", {
        projectDir: null,
        scope: "project",
        name: "lonely",
        description: "X",
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
  });
});

describe("/agents", () => {
  it("lists the agents in use, for clients without Settings", async () => {
    const peer = await connected();
    const { session } = await peer.request("session.create", { cwd: TALLY });
    expect((await peer.request("session.resume", { sessionId: session.id })).commands).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "agents" })]),
    );
    const { output } = await peer.request("session.command", {
      sessionId: session.id,
      name: "agents",
    });
    expect(output).toContain("Explore (built in)");
    expect(output).toContain("code-reviewer (project)");
    expect(output).not.toContain("designer");
  });
});
