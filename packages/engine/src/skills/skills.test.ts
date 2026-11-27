// biome-ignore-all lint/suspicious/noTemplateCurlyInString: skill bodies write ${CLAUDE_*} variables literally
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DAWG_COMMAND_NAMES, type SkillDefinition } from "@dawg/compat";
import { text, toolCall } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_COMMANDS } from "../commands/builtins.ts";
import { createPromptAssembler } from "../prompt/index.ts";
import { type Harness, startHarness } from "../runtime/__fixtures__/harness.ts";
import type { CodeTrust } from "../trust/index.ts";
import { LISTING_HEADER, listingBudgetChars, renderSkillListing } from "./listing.ts";
import { exitOneIsResult, runInjectedCommand } from "./shell.ts";

let h: Harness | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

interface Body {
  messages: { role: string; content: unknown }[];
  tools?: { function?: { name?: string } }[];
}

function mainBodies(harness: Harness): Body[] {
  return harness.mock.chatRequests.filter((r) => r.lane === "main").map((r) => r.body as Body);
}

function systemOf(body: Body | undefined): string {
  return String(body?.messages[0]?.content ?? "");
}

function toolNames(body: Body | undefined): string[] {
  return (body?.tools ?? []).map((t) => t.function?.name ?? "");
}

/** The text of every message after the system message, joined. */
function historyText(body: Body | undefined): string {
  return JSON.stringify(body?.messages.slice(1) ?? []);
}

const SKILL = (fields: string, body: string) => `---\n${fields}\n---\n${body}\n`;

/** The project's code is approved (the trust store's answer), so its skills' shell may run. */
const APPROVED: CodeTrust = {
  approval: async () => null,
  decide: async () => true,
  allows: async () => true,
};

function definition(
  name: string,
  description: string,
  extra: Partial<SkillDefinition> = {},
): SkillDefinition {
  return {
    kind: "skill",
    name,
    description,
    descriptionFrom: "front-matter",
    whenToUse: null,
    argumentHint: null,
    argumentNames: [],
    allowedTools: [],
    disallowedTools: [],
    model: null,
    fork: false,
    userInvocable: true,
    modelInvocable: true,
    body: "",
    path: `/p/.claude/skills/${name}/SKILL.md`,
    dir: `/p/.claude/skills/${name}`,
    source: { path: `/p/.claude/skills/${name}/SKILL.md`, origin: "claude", scope: "project" },
    status: "loaded",
    notes: [],
    shadowedBy: null,
    inlineShell: false,
    ...extra,
  };
}

async function homeSkill(harness: Harness, name: string, text: string): Promise<void> {
  const file = path.join(harness.home, ".claude", "skills", name, "SKILL.md");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

describe("the listing", () => {
  it("lists what the agent may load, sorted, and drops descriptions from the end past the budget", () => {
    const skills = [
      definition("alpha", "First one"),
      definition("beta", "Second one"),
      definition("gamma", "Only the person runs it", { modelInvocable: false }),
    ];
    expect(renderSkillListing(skills, 8000)).toBe(
      `${LISTING_HEADER}\n- alpha: First one\n- beta: Second one`,
    );
    expect(renderSkillListing(skills, 20)).toBe(`${LISTING_HEADER}\n- alpha\n- beta`);
    const tight = renderSkillListing(skills, "- alpha: First one\n- beta\n".length);
    expect(tight).toBe(`${LISTING_HEADER}\n- alpha: First one\n- beta`);
    expect(renderSkillListing([definition("x", "y", { modelInvocable: false })], 8000)).toBe("");
    expect(listingBudgetChars(32_768)).toBe(8000);
    expect(listingBudgetChars(1_000_000)).toBe(40_000);
  });

  it("goes into the static prompt with the Skill tool, and stays put when skills change mid-session", async () => {
    h = await startHarness({
      engine: { assembler: createPromptAssembler() },
      files: {
        ".claude/skills/review/SKILL.md": SKILL("description: Review the changes", "Review."),
        ".claude/commands/greet.md": SKILL("description: Greet someone", "Say hello."),
      },
      script: [text("One."), text("Two."), text("Three.")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("first"));
    // Added while the session runs: the next session sees it, this one does not.
    await homeSkill(h, "later", SKILL("description: Added later", "Later."));
    await session.run(ask("second"));
    const [first, second] = mainBodies(h);
    expect(systemOf(first)).toContain(
      `${LISTING_HEADER}\n- greet: Greet someone\n- review: Review the changes`,
    );
    expect(toolNames(first)).toContain("Skill");
    expect(systemOf(second)).toBe(systemOf(first));
    expect(JSON.stringify(second?.tools)).toBe(JSON.stringify(first?.tools));
    const next = await h.engine.createSession({ cwd: h.project });
    await next.run(ask("third"));
    expect(systemOf(mainBodies(h)[2])).toContain("- later: Added later");
  });

  it("a session without skills has neither the listing nor the tool", async () => {
    h = await startHarness({
      engine: { assembler: createPromptAssembler() },
      script: [text("Hi.")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("hello"));
    const [first] = mainBodies(h);
    expect(systemOf(first)).not.toContain("# Skills");
    expect(toolNames(first)).not.toContain("Skill");
  });
});

describe("the Skill tool", () => {
  it("loads the body with its substitutions and command output; the next request holds it", async () => {
    h = await startHarness({
      engine: { trust: APPROVED },
      files: {
        ".claude/skills/review/SKILL.md": SKILL(
          "description: Review code\narguments: focus",
          "Review $focus in ${CLAUDE_SKILL_DIR}.\nBranch: !`echo main`\nSee @notes.md",
        ),
        "notes.md": "Be kind.\n",
      },
      script: [toolCall("Skill", { skill: "review", args: "src" }), text("Reviewed.")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const outcome = await session.run(ask("review please"));
    expect(outcome.stopReason).toBe("completed");
    const finished = h.ofType(session.id, "tool.finished")[0]?.payload as unknown as {
      outcome: string;
      content: { text: string }[];
    };
    expect(finished.outcome).toBe("success");
    const result = finished.content[0]?.text ?? "";
    const dir = path.join(h.project, ".claude", "skills", "review");
    expect(result).toContain(`Loaded the skill "review" from ${path.join(dir, "SKILL.md")}`);
    expect(result).toContain(`Review src in ${dir}.\nBranch: main\nSee @notes.md`);
    expect(result).toContain(`Contents of ${path.join(h.project, "notes.md")}`);
    expect(result).toContain("Be kind.");
    expect(historyText(mainBodies(h)[1])).toContain("Review src in");
  });

  it("refuses a command that needs permission, unless the skill's allowed-tools covers it", async () => {
    h = await startHarness({
      engine: { capabilities: { permissionPrompts: false }, trust: APPROVED },
      files: {
        ".claude/skills/blocked/SKILL.md": SKILL(
          "description: Blocked",
          "Stamp: !`touch stamp.txt`",
        ),
        ".claude/skills/granted/SKILL.md": SKILL(
          "description: Granted\nallowed-tools: Bash(touch *)",
          "Stamp: !`touch stamp.txt && echo done`",
        ),
      },
      script: [
        toolCall("Skill", { skill: "blocked" }),
        toolCall("Skill", { skill: "granted" }),
        // The grant holds for the rest of the turn...
        toolCall("Bash", { command: "touch again.txt" }),
        text("Done."),
        // ...and ends with the person's next message.
        toolCall("Bash", { command: "touch third.txt" }),
        text("Done again."),
      ],
      // Loading a skill that grants tools asks first, as documented: allowed by a rule here.
    });
    await mkdir(path.join(h.project, ".dawg"), { recursive: true });
    await writeFile(
      path.join(h.project, ".dawg", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Skill(granted)"] } }),
    );
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("go"));
    const results = h.ofType(session.id, "tool.finished").map(
      (e) =>
        e.payload as unknown as {
          toolName: string;
          outcome: string;
          content: { text: string }[];
        },
    );
    expect(results[0]).toMatchObject({ toolName: "Skill", outcome: "error" });
    expect(results[0]?.content[0]?.text).toContain(
      "needs permission, and a skill's commands cannot ask for it",
    );
    expect(results[1]).toMatchObject({ toolName: "Skill", outcome: "success" });
    expect(results[1]?.content[0]?.text).toContain("Stamp: done");
    expect(results[2]).toMatchObject({ toolName: "Bash", outcome: "success" });
    await session.run(ask("once more"));
    const later = h
      .ofType(session.id, "tool.finished")
      .map((e) => e.payload as unknown as { toolName: string; outcome: string });
    expect(later[3]).toMatchObject({ toolName: "Bash", outcome: "denied" });
  });

  it("asks before loading a skill that grants tools, and honours Skill(...) deny rules", async () => {
    h = await startHarness({
      engine: { capabilities: { permissionPrompts: false } },
      files: {
        ".claude/skills/granted/SKILL.md": SKILL("allowed-tools: Bash", "x"),
        ".claude/skills/plain/SKILL.md": SKILL("description: Plain", "Plain body."),
        ".claude/skills/denied/SKILL.md": SKILL("description: Denied", "Denied body."),
        ".dawg/settings.json": JSON.stringify({ permissions: { deny: ["Skill(denied)"] } }),
      },
      script: [
        toolCall("Skill", { skill: "granted" }),
        toolCall("Skill", { skill: "plain" }),
        toolCall("Skill", { skill: "denied" }),
        text("Done."),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("go"));
    const outcomes = h
      .ofType(session.id, "tool.finished")
      .map((e) => (e.payload as unknown as { outcome: string }).outcome);
    expect(outcomes).toEqual(["denied", "success", "denied"]);
  });

  it("a skill only the person may start loads only when their message names it; an identical reload is a short note", async () => {
    h = await startHarness({
      files: {
        ".claude/skills/deploy/SKILL.md": SKILL(
          "description: Deploy\ndisable-model-invocation: true",
          "Deploy now.",
        ),
        ".claude/skills/style/SKILL.md": SKILL("description: Style", "Use tabs."),
      },
      script: [
        toolCall("Skill", { skill: "deploy" }),
        text("Asked them."),
        toolCall("Skill", { skill: "/Deploy" }),
        toolCall("Skill", { skill: "style" }),
        toolCall("Skill", { skill: "style" }),
        text("Done."),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("ship it"));
    await session.run(ask("go ahead and /deploy to staging"));
    const results = h
      .ofType(session.id, "tool.finished")
      .map((e) => e.payload as unknown as { outcome: string; content: { text: string }[] });
    expect(results[0]?.outcome).toBe("error");
    expect(results[0]?.content[0]?.text).toContain("suggest that they run /deploy");
    expect(results[1]?.content[0]?.text).toContain("Deploy now.");
    expect(results[2]?.content[0]?.text).toContain("Use tabs.");
    expect(results[3]?.content[0]?.text).toBe(
      'The skill "style" is already loaded above, unchanged. Follow it from there.',
    );
    // The skill the person may only start is not in the listing.
    expect(systemOf(mainBodies(h)[0])).not.toContain("- deploy");
  });

  it("re-attaches loaded skills after compaction, right after the summary", async () => {
    h = await startHarness({
      engine: { assembler: createPromptAssembler() },
      files: { ".claude/skills/style/SKILL.md": SKILL("description: Style", "Use tabs, always.") },
      script: [toolCall("Skill", { skill: "style" }), text("Loaded."), text("After.")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("load the style"));
    const compacted = await session.compact();
    expect(compacted.outcome).toBe("completed");
    const view = session
      .requestMessages()
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    const note = view.findIndex((m) => m.includes("attached again after it was summarised"));
    // After the session context and the summary, before anything kept.
    expect(note).toBe(3);
    expect(view[note]).toContain('<skill name=\\"style\\">\\nUse tabs, always.\\n</skill>');
    // Reopened, the session still knows the skill is in context.
    await session.close();
    const reopened = await h.engine.resumeSession(session.id);
    expect(
      reopened.skills.record(reopened.skills.find("style") as SkillDefinition, "Use tabs, always."),
    ).toBe(true);
  });

  it("tells the agent about skills of a folder inside the project once it works there", async () => {
    h = await startHarness({
      files: {
        ".claude/skills/root/SKILL.md": SKILL("description: Root", "Root."),
        "apps/web/.claude/skills/storybook/SKILL.md": SKILL(
          "description: Run Storybook",
          "Run it.",
        ),
        "apps/web/index.ts": "export {};\n",
      },
      script: [
        toolCall("Read", { file_path: "apps/web/index.ts" }),
        toolCall("Skill", { skill: "storybook" }),
        text("Ok."),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("look at the web app"));
    const bodies = mainBodies(h);
    expect(historyText(bodies[1])).toContain("More skills apply in the folder you are working in");
    expect(historyText(bodies[1])).toContain("storybook: Run Storybook");
    const last = h.ofType(session.id, "tool.finished").at(-1)?.payload as unknown as {
      outcome: string;
    };
    expect(last.outcome).toBe("success");
    // The static prompt never changed.
    expect(systemOf(bodies[2])).toBe(systemOf(bodies[0]));
  });
});

describe("commands in a skill body", () => {
  it("exit 1 is a result for search and compare commands only", async () => {
    expect(exitOneIsResult("grep -r foo src")).toBe(true);
    expect(exitOneIsResult("git diff --quiet")).toBe(true);
    expect(exitOneIsResult("cat x | rg foo")).toBe(true);
    expect(exitOneIsResult("false")).toBe(false);
    const signal = new AbortController().signal;
    const base = { cwd: process.cwd(), env: {}, timeoutMs: 10_000, maxChars: 1000, signal };
    expect(await runInjectedCommand({ ...base, command: "echo hi; exit 1" })).toMatchObject({
      ok: false,
      reason: "failed",
      code: 1,
      output: "hi",
    });
    expect(await runInjectedCommand({ ...base, command: "printf 'a\\nb\\n'" })).toEqual({
      ok: true,
      output: "a\nb",
    });
    expect(await runInjectedCommand({ ...base, command: "grep nothing-here /dev/null" })).toEqual({
      ok: true,
      output: "",
    });
  });
});

describe("dawg's own command names", () => {
  it("compat's list matches the built-in commands and their aliases", () => {
    const names = BUILTIN_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]).sort();
    expect([...DAWG_COMMAND_NAMES].sort()).toEqual(names);
  });
});
