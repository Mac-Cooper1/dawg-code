import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { text } from "@dawg/mock-model";
import { RpcError } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Setup, setup } from "../host/__fixtures__/setup.ts";

let s: Setup | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

const FILES = {
  ".claude/commands/greet.md":
    "---\ndescription: Greet someone\nargument-hint: [name]\nallowed-tools: Bash(touch *)\n---\nSay hello to $ARGUMENTS warmly.\n",
  ".claude/commands/frontend/test.md": "Run the frontend tests.\n",
  ".claude/commands/compact.md": "My own compact.\n",
  ".claude/skills/review/SKILL.md":
    "---\ndescription: Review the changes\n---\nReview carefully.\n",
  ".claude/skills/background/SKILL.md":
    "---\ndescription: Background facts\nuser-invocable: false\n---\nFacts.\n",
  ".claude/skills/broken/SKILL.md":
    "---\ndescription: Broken\n---\nState: !`cat missing-file.txt`\n",
};

describe("skills and custom commands as slash commands", () => {
  it("the snapshot lists them with their source and kind; dawg's own keep their names", async () => {
    s = await setup({ files: FILES });
    const home = path.join(s.home, ".dawg", "commands");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "standup.md"), "Write my standup.\n");
    const c = await s.connect();
    const snapshot = await c.client.request("session.create", { cwd: s.project });
    const byName = new Map(snapshot.commands.map((command) => [command.name, command]));
    expect(byName.get("greet")).toEqual({
      name: "greet",
      description: "Greet someone",
      argumentHint: "[name]",
      source: "project",
      kind: "command",
    });
    expect(byName.get("frontend:test")).toMatchObject({ source: "project", kind: "command" });
    expect(byName.get("review")).toMatchObject({
      source: "project",
      kind: "skill",
      argumentHint: null,
    });
    expect(byName.get("standup")).toMatchObject({ source: "user" });
    expect(byName.get("compact")).toMatchObject({ source: "builtin" });
    expect(byName.has("background")).toBe(false);
  });

  it("/greet Ada sends the expanded prompt and shows the command as typed; /help says where it comes from", async () => {
    s = await setup({ files: FILES, script: [text("Hello, Ada!")] });
    const c = await s.connect();
    const { session } = await c.client.request("session.create", { cwd: s.project });
    const result = await c.client.request("session.command", {
      sessionId: session.id,
      name: "greet",
      args: "Ada",
    });
    expect(result.turnId).not.toBeNull();
    await c.waitFor((e) => e.event === "turn.finished" && e.payload.sessionId === session.id);
    const started = c.events.find((e) => e.event === "turn.started");
    expect(started?.payload).toMatchObject({
      prompt: { content: [{ type: "text", text: "/greet Ada" }] },
      command: { name: "greet", args: "Ada" },
    });
    const request = JSON.stringify(s.mock.chatRequests[0]?.body);
    expect(request).toContain("/greet Ada\\n\\nSay hello to Ada warmly.");
    const help = await c.client.request("session.command", { sessionId: session.id, name: "help" });
    expect(help.output).toMatch(/\/greet \[name\]\s+Greet someone \(project\)/);
    const one = await c.client.request("session.command", {
      sessionId: session.id,
      name: "help",
      args: "review",
    });
    expect(one.output).toContain("A skill from the project's files.");
  });

  it("a command whose ! command fails is not sent, and says why", async () => {
    s = await setup({
      files: FILES,
      engine: {
        trust: { approval: async () => null, decide: async () => true, allows: async () => true },
      },
    });
    const c = await s.connect();
    const { session } = await c.client.request("session.create", { cwd: s.project });
    const failed = await c.client
      .request("session.command", { sessionId: session.id, name: "broken" })
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(RpcError);
    expect((failed as RpcError).message).toContain(
      "failed with exit code 1, so /broken did not run",
    );
    expect(s.mock.chatRequests).toHaveLength(0);
  });

  it("project.skills lists every skill and command with who may run it", async () => {
    s = await setup({ files: FILES });
    const c = await s.connect();
    const result = await c.client.request("project.skills", { projectDir: s.project });
    expect(result.skills.map((k) => [k.name, k.userInvocable, k.modelInvocable])).toEqual([
      ["background", false, true],
      ["broken", true, true],
      ["review", true, true],
    ]);
    expect(result.commands.map((k) => [k.name, k.userInvocable, k.status])).toEqual([
      ["compact", false, "partly-supported"],
      ["frontend:test", true, "loaded"],
      ["greet", true, "loaded"],
    ]);
    expect(result.commands[0]?.notes.join(" ")).toContain("/compact is one of dawg's own commands");
    const mine = await c.client.request("project.skills", { projectDir: null });
    expect(mine).toEqual({ projectDir: null, skills: [], commands: [] });
  });
});
