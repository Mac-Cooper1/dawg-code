// biome-ignore-all lint/suspicious/noTemplateCurlyInString: hook definitions write ${VAR} and ${path} literally, as the hooks reference does
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CompatSource } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  eventTier,
  handlerRunsOn,
  isRunningEvent,
  isTier1Event,
  RUNNING_TIER_3_EVENTS,
  TIER_2_EVENTS,
} from "./events.ts";
import {
  headerVariablesAllowed,
  httpHookAllowed,
  httpUrlAllowed,
  interpolateHeaders,
} from "./http.ts";
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
    // Every tier 2 event runs.
    for (const event of TIER_2_EVENTS) {
      expect(eventTier(event)).toBe(2);
      expect(isRunningEvent(event)).toBe(true);
      expect(
        hookSupport(one({ [event]: [{ hooks: [{ type: "command", command: "x" }] }] })).status,
      ).toBe("loaded");
    }
    // The tier 3 events whose feature exists run too; the rest do not yet.
    for (const event of RUNNING_TIER_3_EVENTS) {
      expect(eventTier(event)).toBe(3);
      expect(
        hookSupport(one({ [event]: [{ hooks: [{ type: "command", command: "x" }] }] })).status,
      ).toBe("loaded");
    }
    expect(isRunningEvent("FileChanged")).toBe(false);
    expect(eventTier("PreCompact")).toBe(2);
    expect(eventTier("FileChanged")).toBe(3);
    expect(eventTier("Nope")).toBeNull();
  });

  it("runs every handler type on the events the reference lists for it", () => {
    for (const handler of [
      { type: "http", url: "http://localhost:8080/hook" },
      { type: "prompt", prompt: "Is it done? $ARGUMENTS" },
      { type: "agent", prompt: "Check the tests." },
      { type: "mcp_tool", server: "s", tool: "t" },
    ]) {
      expect(hookSupport(one({ Stop: [{ hooks: [handler] }] })).status).toBe("loaded");
    }
    // The reference's table, row by row where it surprises.
    expect(handlerRunsOn("prompt", "PermissionRequest")).toBe(true);
    expect(handlerRunsOn("agent", "PermissionRequest")).toBe(false);
    expect(handlerRunsOn("prompt", "PreCompact")).toBe(false);
    expect(handlerRunsOn("http", "PostCompact")).toBe(true);
    expect(handlerRunsOn("http", "SessionStart")).toBe(false);
    expect(handlerRunsOn("mcp_tool", "SessionStart")).toBe(true);
    expect(handlerRunsOn("mcp_tool", "Setup")).toBe(false);
    expect(handlerRunsOn("webhook", "Stop")).toBe(false);
  });

  it("does not run a type where Claude Code does not, later tiers or PowerShell, and says why", () => {
    const cases: [unknown, string][] = [
      [
        { PermissionRequest: [{ hooks: [{ type: "agent", prompt: "x" }] }] },
        "does not run agent hooks on PermissionRequest",
      ],
      [
        { SessionEnd: [{ hooks: [{ type: "prompt", prompt: "x" }] }] },
        "does not run prompt hooks on SessionEnd",
      ],
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

  it("names what is mapped or ignored by design: model, once, unlisted header variables", () => {
    const prompt = hookSupport(
      one({ Stop: [{ hooks: [{ type: "prompt", prompt: "x", model: "haiku", once: true }] }] }),
    );
    expect(prompt.status).toBe("loaded");
    expect(prompt.notes.join(" ")).toContain("model “haiku” is mapped");
    expect(prompt.notes.join(" ")).toContain("“once” counts only in a skill");
    const http = hookSupport(
      one({
        Stop: [
          {
            hooks: [
              {
                type: "http",
                url: "https://hooks.example.com/stop",
                headers: { Authorization: "Bearer $TOKEN", "X-User": "${USER}" },
                allowedEnvVars: ["TOKEN"],
              },
            ],
          },
        ],
      }),
    );
    expect(http.status).toBe("loaded");
    expect(http.notes.join(" ")).toContain("$USER");
    expect(http.notes.join(" ")).not.toContain("$TOKEN");
    // continueOnBlock is a prompt hook's field, not an agent hook's.
    const agent = hookSupport(
      one({ Stop: [{ hooks: [{ type: "agent", prompt: "x", continueOnBlock: true }] }] }),
    );
    expect(agent.status).toBe("partly-supported");
    expect(agent.notes.join(" ")).toContain("Not used by dawg: continueOnBlock");
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

describe("handler fields", () => {
  it("reads each type's own fields", () => {
    const http = one({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "http",
              url: "http://localhost:8080/hooks/pre-tool-use",
              timeout: 30,
              headers: { Authorization: "Bearer $MY_TOKEN" },
              allowedEnvVars: ["MY_TOKEN"],
            },
          ],
        },
      ],
    }).handler;
    expect(http).toMatchObject({
      type: "http",
      url: "http://localhost:8080/hooks/pre-tool-use",
      headers: { Authorization: "Bearer $MY_TOKEN" },
      allowedEnvVars: ["MY_TOKEN"],
      timeout: 30,
      target: "http://localhost:8080/hooks/pre-tool-use",
    });
    const prompt = one({
      Stop: [
        {
          hooks: [
            { type: "prompt", prompt: "Done? $ARGUMENTS", model: "haiku", continueOnBlock: true },
          ],
        },
      ],
    }).handler;
    expect(prompt).toMatchObject({
      prompt: "Done? $ARGUMENTS",
      model: "haiku",
      continueOnBlock: true,
    });
    const mcp = one({
      PostToolUse: [
        {
          matcher: "Write|Edit",
          hooks: [
            {
              type: "mcp_tool",
              server: "my_server",
              tool: "security_scan",
              input: { file_path: "${tool_input.file_path}" },
            },
          ],
        },
      ],
    }).handler;
    expect(mcp).toMatchObject({
      server: "my_server",
      tool: "security_scan",
      input: { file_path: "${tool_input.file_path}" },
      target: "my_server security_scan",
    });
  });

  it("skips handlers missing what their type needs, and says which field", () => {
    const { hooks, problems } = parseHooksValue(
      {
        Stop: [
          {
            hooks: [
              { type: "http" },
              { type: "http", url: "ftp://example.com/x" },
              { type: "prompt" },
              { type: "agent", prompt: "  " },
              { type: "mcp_tool", server: "s" },
              { type: "mcp_tool", server: "s", tool: "t", input: "x" },
            ],
          },
        ],
      },
      SOURCE,
    );
    expect(hooks).toEqual([]);
    expect(problems.map((p) => p.key)).toEqual([
      "hooks.Stop[0].hooks[0].url",
      "hooks.Stop[0].hooks[1].url",
      "hooks.Stop[0].hooks[2].prompt",
      "hooks.Stop[0].hooks[3].prompt",
      "hooks.Stop[0].hooks[4].tool",
      "hooks.Stop[0].hooks[5].input",
    ]);
  });

  it("keeps an http hook whose headers or variables are malformed, without them", () => {
    const { hooks, problems } = parseHooksValue(
      {
        Stop: [
          {
            hooks: [
              { type: "http", url: "http://localhost/x", headers: { A: 1 }, allowedEnvVars: "X" },
            ],
          },
        ],
      },
      SOURCE,
    );
    expect(hooks[0]?.handler).toMatchObject({ headers: {}, allowedEnvVars: [] });
    expect(problems.map((p) => p.key)).toEqual([
      "hooks.Stop[0].hooks[0].headers",
      "hooks.Stop[0].hooks[0].allowedEnvVars",
    ]);
  });
});

describe("HTTP hook settings", () => {
  it("merges allowedHttpHookUrls and httpHookAllowedEnvVars across files", async () => {
    const { home, project } = await setup({
      "home/.dawg/settings.json": {
        allowedHttpHookUrls: ["https://hooks.example.com/*"],
        httpHookAllowedEnvVars: ["MY_TOKEN"],
      },
      "project/.claude/settings.json": {
        allowedHttpHookUrls: ["http://localhost:*"],
        hooks: { Stop: [{ hooks: [{ type: "http", url: "http://localhost:9/x" }] }] },
      },
    });
    const loaded = await loadHooks({ projectDir: project, homeDir: home });
    expect(loaded.http.allowedUrls?.sort()).toEqual([
      "http://localhost:*",
      "https://hooks.example.com/*",
    ]);
    expect(loaded.http.allowedEnvVars).toEqual(["MY_TOKEN"]);
    const none = await loadHooks({ projectDir: null, homeDir: path.join(home, "nobody") });
    expect(none.http).toEqual({ allowedUrls: null, allowedEnvVars: null });
  });

  it.each([
    ["https://hooks.example.com/stop", ["https://hooks.example.com/*"], true],
    ["https://HOOKS.example.com./stop", ["https://hooks.example.com/*"], true],
    ["https://hooks.example.com/stop", ["https://Hooks.Example.com./*"], true],
    ["https://evil.example.com/stop", ["https://hooks.example.com/*"], false],
    ["https://hooks.example.com.evil.net/x", ["https://hooks.example.com/*"], false],
    ["http://localhost:8080/hooks", ["http://localhost:*"], true],
    ["http://127.0.0.1:8080/hooks", ["http://localhost:*"], false],
    ["http://localhost:8080/hooks", [], false],
  ] as const)("%s against %j: %s", (url, patterns, expected) => {
    expect(httpUrlAllowed(url, patterns)).toBe(expected);
  });

  it("lets an http hook run only when the merged list matches its URL", () => {
    const hook = one({ Stop: [{ hooks: [{ type: "http", url: "http://localhost:8080/x" }] }] });
    expect(httpHookAllowed(hook.handler, { allowedUrls: null, allowedEnvVars: null })).toBe(true);
    expect(
      httpHookAllowed(hook.handler, { allowedUrls: ["http://localhost:*"], allowedEnvVars: null }),
    ).toBe(true);
    const off = hookSupport(hook, { allowedUrls: ["https://x.example/*"], allowedEnvVars: null });
    expect(off.status).toBe("not-supported");
    expect(off.notes.join(" ")).toContain("allowedHttpHookUrls");
  });

  it("puts in only the variables both the hook and the settings allow; others become empty", () => {
    const hook = one({
      Stop: [
        {
          hooks: [
            {
              type: "http",
              url: "http://localhost/x",
              headers: { A: "Bearer $MY_TOKEN", B: "${OTHER}-${SECRET}", C: "$NOT_LISTED!" },
              allowedEnvVars: ["MY_TOKEN", "OTHER", "SECRET"],
            },
          ],
        },
      ],
    }).handler;
    const env = { MY_TOKEN: "t0k", OTHER: "o", SECRET: "s", NOT_LISTED: "n" };
    expect(
      interpolateHeaders(
        hook.headers,
        headerVariablesAllowed(hook, { allowedUrls: null, allowedEnvVars: null }),
        env,
      ),
    ).toEqual({ A: "Bearer t0k", B: "o-s", C: "!" });
    const narrowed = headerVariablesAllowed(hook, {
      allowedUrls: null,
      allowedEnvVars: ["MY_TOKEN", "OTHER"],
    });
    expect(interpolateHeaders(hook.headers, narrowed, env)).toEqual({
      A: "Bearer t0k",
      B: "o-",
      C: "!",
    });
  });
});
