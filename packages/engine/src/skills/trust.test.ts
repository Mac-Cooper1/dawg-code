/**
 * Skills and commands from a project's files with inline shell or `allowed-tools` are code the
 * project supplies (Phase 4 spec, principle 3): their shell runs, and their grants apply, only
 * once the person has approved the project's code (`CodeTrust.allows`). The person's own skills
 * behave as before.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { text, toolCall } from "@dawg/mock-model";
import type { CompatSource } from "@dawg/protocol";
import { RpcError } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Setup, setup } from "../host/__fixtures__/setup.ts";
import { type Harness, startHarness } from "../runtime/__fixtures__/harness.ts";
import type { CodeTrust } from "../trust/index.ts";

let h: Harness | null = null;
let s: Setup | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  await s?.close();
  h = null;
  s = null;
});

/** A trust store that answers every question the same way, and remembers what it was asked. */
function fakeTrust(approved: boolean): CodeTrust & { asked: CompatSource[] } {
  const asked: CompatSource[] = [];
  return {
    asked,
    approval: async () => null,
    decide: async () => approved,
    allows: async (source) => {
      asked.push(source);
      return approved;
    },
  };
}

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const NEEDS_APPROVAL =
  "/stamp runs commands from the project's files, which need your approval of the project's code first: give it in Settings → Project setup, or when dawg asks about this project.";

const PROJECT_FILES = {
  // Inline shell and a grant: project code.
  ".claude/commands/stamp.md":
    "---\ndescription: Stamp the build\nallowed-tools: Bash(touch *)\n---\nBuilt on !`echo today`.\n",
  // A grant only: project code too.
  ".claude/skills/tidy/SKILL.md":
    "---\ndescription: Tidy the files\nallowed-tools: Bash(touch *)\n---\nTidy up.\n",
};

type Finished = { toolName: string; outcome: string; content: { text: string }[] };

function finished(harness: Harness, sessionId: string): Finished[] {
  return harness.ofType(sessionId, "tool.finished").map((e) => e.payload as unknown as Finished);
}

describe("project code in skills and commands", () => {
  it("unapproved: /stamp does not run its shell and says where to approve; nothing is sent", async () => {
    s = await setup({ files: PROJECT_FILES, engine: { trust: fakeTrust(false) } });
    const c = await s.connect();
    const { session } = await c.client.request("session.create", { cwd: s.project });
    const refused = await c.client
      .request("session.command", { sessionId: session.id, name: "stamp" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RpcError);
    expect((refused as RpcError).message).toBe(NEEDS_APPROVAL);
    expect(s.mock.chatRequests).toHaveLength(0);
  });

  it("unapproved: the agent's Skill call gets the same sentence, and a skill's grants do not apply", async () => {
    const trust = fakeTrust(false);
    h = await startHarness({
      engine: { capabilities: { permissionPrompts: false }, trust },
      files: {
        ...PROJECT_FILES,
        // Loading skills that grant tools asks first: allowed here, so only the grant is tested.
        ".dawg/settings.json": JSON.stringify({
          permissions: { allow: ["Skill(stamp)", "Skill(tidy)"] },
        }),
      },
      script: [
        toolCall("Skill", { skill: "stamp" }),
        toolCall("Skill", { skill: "tidy" }),
        toolCall("Bash", { command: "touch tidy.txt" }),
        text("Done."),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("stamp and tidy"));
    const results = finished(h, session.id);
    expect(results[0]).toMatchObject({ toolName: "Skill", outcome: "error" });
    expect(results[0]?.content[0]?.text).toBe(`Error: ${NEEDS_APPROVAL}`);
    // The skill loads (no shell in it), but its allowed-tools do not: the touch asks, and with
    // nobody to answer it is denied.
    expect(results[1]).toMatchObject({ toolName: "Skill", outcome: "success" });
    expect(results[2]).toMatchObject({ toolName: "Bash", outcome: "denied" });
    expect(trust.asked.map((source) => source.scope)).toEqual(["project", "project"]);
  });

  it("approved: the shell runs and the grants apply", async () => {
    h = await startHarness({
      engine: { capabilities: { permissionPrompts: false }, trust: fakeTrust(true) },
      files: {
        ...PROJECT_FILES,
        ".dawg/settings.json": JSON.stringify({ permissions: { allow: ["Skill(stamp)"] } }),
      },
      script: [
        toolCall("Skill", { skill: "stamp" }),
        toolCall("Bash", { command: "touch stamped.txt" }),
        text("Done."),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("stamp it"));
    const results = finished(h, session.id);
    expect(results[0]).toMatchObject({ toolName: "Skill", outcome: "success" });
    expect(results[0]?.content[0]?.text).toContain("Built on today.");
    expect(results[1]).toMatchObject({ toolName: "Bash", outcome: "success" });
  });

  it("the person's own skills and commands need no approval", async () => {
    const trust = fakeTrust(false);
    s = await setup({ script: [text("Stamped.")], engine: { trust } });
    const commands = path.join(s.home, ".claude", "commands");
    await mkdir(commands, { recursive: true });
    await writeFile(
      path.join(commands, "mine.md"),
      "---\nallowed-tools: Bash(touch *)\n---\nBuilt on !`echo today`.\n",
    );
    const c = await s.connect();
    const { session } = await c.client.request("session.create", { cwd: s.project });
    const result = await c.client.request("session.command", {
      sessionId: session.id,
      name: "mine",
    });
    expect(result.turnId).not.toBeNull();
    await c.waitFor((e) => e.event === "turn.finished" && e.payload.sessionId === session.id);
    expect(JSON.stringify(s.mock.chatRequests[0]?.body)).toContain("Built on today.");
    expect(trust.asked).toEqual([]);
  });
});

describe("built-in commands that start a turn", () => {
  it("/init shows the command as typed; the model gets the full prompt", async () => {
    s = await setup({ script: [text("Wrote CLAUDE.md.")] });
    const c = await s.connect();
    const { session } = await c.client.request("session.create", { cwd: s.project });
    const result = await c.client.request("session.command", {
      sessionId: session.id,
      name: "init",
      args: "keep it short",
    });
    await c.waitFor((e) => e.event === "turn.finished" && e.payload.turnId === result.turnId);
    const started = c.events.find((e) => e.event === "turn.started");
    expect(started?.payload).toMatchObject({
      prompt: { content: [{ type: "text", text: "/init keep it short" }], mentions: [] },
      command: { name: "init", args: "keep it short" },
    });
    expect(JSON.stringify(s.mock.chatRequests[0]?.body)).toContain("CLAUDE.md");
  });
});
