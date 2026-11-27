import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CompatSource } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { eventTier, isTier1Event } from "./events.ts";
import { type HookDefinition, loadHooks, parseHooksValue } from "./read.ts";
import { hookItemName, hookSupport, readsTranscript } from "./support.ts";

const SOURCE: CompatSource = {
  path: "/p/.claude/settings.json",
  origin: "claude",
  scope: "project",
};

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(files: Record<string, unknown>): Promise<{ home: string; project: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "dawg-hooks-"));
  roots.push(root);
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
  }
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  return { home, project };
}

function one(value: unknown): HookDefinition {
  const { hooks, problems } = parseHooksValue(value, SOURCE);
  expect(problems).toEqual([]);
  expect(hooks).toHaveLength(1);
  return hooks[0] as HookDefinition;
}

describe("reading the hooks key", () => {
  it("reads the documented shape: event → matcher groups → handlers", () => {
    const { hooks, problems } = parseHooksValue(
      {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "./a.sh", timeout: 5 },
              { type: "command", command: "node", args: ["check.js", "--strict"] },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
      },
      SOURCE,
    );
    expect(problems).toEqual([]);
    expect(hooks.map((h) => [h.event, h.matcher, h.handler.target, h.handler.timeout])).toEqual([
      ["PreToolUse", "Bash", "./a.sh", 5],
      ["PreToolUse", "Bash", "node check.js --strict", null],
      ["Stop", null, "say done", null],
    ]);
    expect(hooks[1]?.handler.args).toEqual(["check.js", "--strict"]);
    expect(hooks[0]?.location).toBe("hooks.PreToolUse[0].hooks[0]");
  });

  it("reports and skips what does not follow the shape, keeping the rest", () => {
    const { hooks, problems } = parseHooksValue(
      {
        PreToolUse: { matcher: "Bash" },
        PostToolUse: [
          "lint",
          { matcher: 3, hooks: [] },
          { hooks: [{ command: "x" }, { type: "command" }, { type: "command", command: "ok" }] },
        ],
      },
      SOURCE,
    );
    expect(hooks.map((h) => h.handler.command)).toEqual(["ok"]);
    expect(problems.map((p) => p.key)).toEqual([
      "hooks.PreToolUse",
      "hooks.PostToolUse[0]",
      "hooks.PostToolUse[1].matcher",
      "hooks.PostToolUse[2].hooks[0].type",
      "hooks.PostToolUse[2].hooks[1].command",
    ]);
  });

  it("keeps a handler with a bad timeout, at the default, and says so", () => {
    const { hooks, problems } = parseHooksValue(
      { Stop: [{ hooks: [{ type: "command", command: "x", timeout: -1 }] }] },
      SOURCE,
    );
    expect(hooks[0]?.handler.timeout).toBeNull();
    expect(problems[0]?.message).toContain("the default applies");
  });

  it("merges every file and reads disableAllHooks after precedence", async () => {
    const { home, project } = await setup({
      "home/.dawg/settings.json": {
        disableAllHooks: true,
        hooks: { Stop: [{ hooks: [{ type: "command", command: "a" }] }] },
      },
      "home/.claude/settings.json": {
        hooks: { Stop: [{ hooks: [{ type: "command", command: "b" }] }] },
      },
      "project/.claude/settings.json": {
        hooks: { Stop: [{ hooks: [{ type: "command", command: "c" }] }] },
      },
    });
    const loaded = await loadHooks({ projectDir: project, homeDir: home });
    expect(loaded.hooks.map((h) => h.handler.command)).toEqual(["c", "a", "b"]);
    expect(loaded.disabledBy).toBe(path.join(home, ".dawg", "settings.json"));

    // A project's false outranks the person's true ("a project's false overrides a user-level true").
    await writeFile(
      path.join(project, ".claude", "settings.local.json"),
      JSON.stringify({ disableAllHooks: false }),
    );
    expect((await loadHooks({ projectDir: project, homeDir: home })).disabledBy).toBeNull();
  });

  it("reads only the person's files without a project", async () => {
    const { home } = await setup({
      "home/.claude/settings.json": {
        hooks: { Stop: [{ hooks: [{ type: "command", command: "b" }] }] },
      },
    });
    const loaded = await loadHooks({ projectDir: null, homeDir: home });
    expect(loaded.files.map((f) => f.source.scope)).toEqual(["user", "user"]);
    expect(loaded.hooks[0]?.source).toEqual({
      path: path.join(home, ".claude", "settings.json"),
      origin: "claude",
      scope: "user",
    });
  });
});

describe("what dawg does with a handler", () => {
  it("runs tier 1 command hooks", () => {
    for (const event of [
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
      "Stop",
      "SessionStart",
      "SessionEnd",
      "Notification",
    ]) {
      expect(isTier1Event(event)).toBe(true);
      expect(
        hookSupport(one({ [event]: [{ hooks: [{ type: "command", command: "x" }] }] })).status,
      ).toBe("loaded");
    }
    // The subagent events are tier 2 and run already.
    for (const event of ["SubagentStart", "SubagentStop"]) {
      expect(eventTier(event)).toBe(2);
      expect(
        hookSupport(one({ [event]: [{ hooks: [{ type: "command", command: "x" }] }] })).status,
      ).toBe("loaded");
    }
    expect(eventTier("PreCompact")).toBe(2);
    expect(eventTier("FileChanged")).toBe(3);
    expect(eventTier("Nope")).toBeNull();
  });

  it("does not run other handler types, later tiers or PowerShell, and says why", () => {
    const cases: [unknown, string][] = [
      [{ Stop: [{ hooks: [{ type: "agent", prompt: "x" }] }] }, "agent hooks"],
      [{ Stop: [{ hooks: [{ type: "mcp_tool", server: "s", tool: "t" }] }] }, "mcp_tool hooks"],
      [{ PreCompact: [{ hooks: [{ type: "command", command: "x" }] }] }, "next in Phase 4"],
      [{ CwdChanged: [{ hooks: [{ type: "command", command: "x" }] }] }, "CwdChanged hooks yet"],
      [
        { Stop: [{ hooks: [{ type: "command", command: "x", shell: "powershell" }] }] },
        "powershell",
      ],
      [{ Stop: [{ hooks: [{ type: "webhook", url: "x" }] }] }, "not a hook type"],
    ];
    for (const [value, note] of cases) {
      const support = hookSupport(one(value));
      expect(support.status).toBe("not-supported");
      expect(support.notes.join(" ")).toContain(note);
    }
  });

  it("names unsupported fields and documented surprises", () => {
    const partly = hookSupport(
      one({
        Stop: [{ hooks: [{ type: "command", command: "x", asyncRewake: true, colour: "red" }] }],
      }),
    );
    expect(partly.status).toBe("partly-supported");
    expect(partly.notes.join(" ")).toContain("asyncRewake");
    expect(partly.notes.join(" ")).toContain("Not used by dawg: colour");
    const noted = hookSupport(
      one({
        UserPromptSubmit: [
          { matcher: "Bash", hooks: [{ type: "command", command: "x", if: "Bash(rm *)" }] },
        ],
      }),
    );
    expect(noted.status).toBe("loaded");
    expect(noted.notes.join(" ")).toContain("never runs");
    expect(noted.notes.join(" ")).toContain("is ignored");
  });

  it("names items as the report shows them", () => {
    expect(
      hookItemName(
        one({
          PreToolUse: [
            { matcher: "Edit|Write", hooks: [{ type: "command", command: "npm run lint" }] },
          ],
        }),
      ),
    ).toBe("PreToolUse on Edit|Write: npm run lint");
    expect(
      hookItemName(
        one({ PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "x" }] }] }),
      ),
    ).toBe("PreToolUse: x");
    expect(
      hookItemName(one({ Stop: [{ matcher: "y", hooks: [{ type: "command", command: "x" }] }] })),
    ).toBe("Stop: x");
  });

  it("finds hooks that read the transcript, in the command or the script it runs", async () => {
    const { home, project } = await setup({
      "project/hooks/summary.sh": '#!/bin/sh\npath=$(jq -r .transcript_path)\nwc -l "$path"\n',
      "project/hooks/plain.sh": "#!/bin/sh\nexit 0\n",
    });
    const context = { projectDir: project, homeDir: home };
    const hook = (command: string) => one({ Stop: [{ hooks: [{ type: "command", command }] }] });
    expect(await readsTranscript(hook('"$CLAUDE_PROJECT_DIR"/hooks/summary.sh'), context)).toBe(
      true,
    );
    expect(await readsTranscript(hook("bash hooks/summary.sh"), context)).toBe(true);
    expect(await readsTranscript(hook("jq -r .transcript_path | xargs cat"), context)).toBe(true);
    expect(await readsTranscript(hook("hooks/plain.sh"), context)).toBe(false);
    expect(await readsTranscript(hook("./missing.sh"), context)).toBe(false);
  });
});
