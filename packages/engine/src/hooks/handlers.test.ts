// biome-ignore-all lint/suspicious/noTemplateCurlyInString: hook definitions write ${VAR} and ${path} literally, as the hooks reference does
/**
 * The handler types other than `command`, run through the session's hook runner: http against a
 * local server, prompt against a scripted model, agent against a stand-in for the session's
 * subagents, mcp_tool against a stand-in for its MCP servers. Then their default timeouts, and
 * consent for project hooks of every type.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UtilityModel, UtilityRequest } from "../contracts/web.ts";
import type { EventFields } from "../loop/types.ts";
import { hookId } from "../trust/definitions.ts";
import { type CodeTrust, NO_CODE_TRUST } from "../trust/index.ts";
import { createTrustStore } from "../trust/store.ts";
import type { HookAgents } from "./agent.ts";
import type { HookMcp } from "./mcp-tool.ts";
import { substituteInput } from "./mcp-tool.ts";
import { promptWithInput, readVerdict } from "./prompt.ts";
import { type HookServices, type HookTimeouts, SessionHooks } from "./session-hooks.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

interface Setup {
  root: string;
  home: string;
  project: string;
  store: string;
  events: { event: string; fields: Record<string, unknown> }[];
  write(rel: string, content: unknown): Promise<string>;
  hooks(options?: {
    trust?: CodeTrust;
    env?: Record<string, string>;
    baseEnv?: NodeJS.ProcessEnv;
    services?: HookServices;
    timeouts?: Partial<HookTimeouts>;
  }): Promise<SessionHooks>;
}

async function setup(): Promise<Setup> {
  const root = await mkdtemp(path.join(tmpdir(), "dawg-hook-types-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const store = path.join(root, "store");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  const events: Setup["events"] = [];
  return {
    root,
    home,
    project,
    store,
    events,
    async write(rel, content) {
      const file = path.join(root, rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
      return file;
    },
    async hooks(options = {}) {
      const hooks = new SessionHooks({
        sessionId: "s1",
        cwd: project,
        projectDir: project,
        homeDir: home,
        transcriptPath: path.join(store, "s1.jsonl"),
        trust: options.trust ?? NO_CODE_TRUST,
        env: () => options.env ?? {},
        mode: () => "default",
        emit: ((event: string, fields: Record<string, unknown>) =>
          events.push({ event, fields })) as never,
        queueNote: () => {},
        now: Date.now,
        ...(options.baseEnv === undefined ? {} : { baseEnv: options.baseEnv }),
        ...(options.services === undefined ? {} : { services: options.services }),
        ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
      });
      cleanups.push(async () => hooks.close());
      await hooks.reload();
      return hooks;
    },
  };
}

function ran(s: Setup): EventFields<"hook.ran">[] {
  return s.events.filter((e) => e.event === "hook.ran").map((e) => e.fields as never);
}

const settings = (hooks: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  hooks,
  ...extra,
});
const signal = () => new AbortController().signal;

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

/** A local hook server: answers each request with `answer`, and keeps what it was sent. */
async function hookServer(
  answer: (req: Received, res: ServerResponse) => void,
): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      text += chunk;
    });
    req.on("end", () => {
      const got: Received = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: text === "" ? null : JSON.parse(text),
      };
      received.push(got);
      answer(got, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, received };
}

const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof value === "string" ? value : JSON.stringify(value));
};

const preToolUse = (hooks: SessionHooks, command = "npm test") =>
  hooks.preToolUse({
    turnId: "t1",
    toolCallId: "c1",
    toolName: "Bash",
    toolInput: { command },
    signal: signal(),
  });

describe("http hooks", () => {
  it("POSTs the hook input as JSON, with headers that read only the variables allowed", async () => {
    const s = await setup();
    const server = await hookServer((_req, res) =>
      json(res, 200, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Tests run in CI only",
        },
      }),
    );
    await s.write(
      "home/.dawg/settings.json",
      settings({
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "http",
                url: `${server.url}/hooks/pre-tool-use`,
                headers: {
                  Authorization: "Bearer $MY_TOKEN",
                  "X-Other": "${OTHER}|$FROM_SETTINGS",
                },
                allowedEnvVars: ["MY_TOKEN", "FROM_SETTINGS"],
              },
            ],
          },
        ],
      }),
    );
    const hooks = await s.hooks({
      baseEnv: { MY_TOKEN: "s3cret", OTHER: "not-allowed" },
      env: { FROM_SETTINGS: "yes" },
    });
    const verdict = await preToolUse(hooks);
    expect(verdict).toMatchObject({ decision: "deny", reason: "Tests run in CI only" });
    const [got] = server.received;
    expect(got?.method).toBe("POST");
    expect(got?.url).toBe("/hooks/pre-tool-use");
    expect(got?.headers["content-type"]).toBe("application/json");
    expect(got?.headers.authorization).toBe("Bearer s3cret");
    expect(got?.headers["x-other"]).toBe("|yes");
    expect(got?.body).toMatchObject({
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    expect(ran(s)[0]).toMatchObject({
      outcome: "blocked",
      decision: "deny",
      exitCode: null,
      hook: { type: "http", command: `${server.url}/hooks/pre-tool-use` },
    });
  });

  it("httpHookAllowedEnvVars narrows what headers may read", async () => {
    const s = await setup();
    const server = await hookServer((_req, res) => json(res, 200, ""));
    await s.write(
      "home/.dawg/settings.json",
      settings(
        {
          Stop: [
            {
              hooks: [
                {
                  type: "http",
                  url: server.url,
                  headers: { "X-A": "$A", "X-B": "$B" },
                  allowedEnvVars: ["A", "B"],
                },
              ],
            },
          ],
        },
        { httpHookAllowedEnvVars: ["A"] },
      ),
    );
    const hooks = await s.hooks({ baseEnv: { A: "one", B: "two" } });
    await hooks.stop({ turnId: "t1", lastMessage: "done", signal: signal() });
    expect(server.received[0]?.headers["x-a"]).toBe("one");
    expect(server.received[0]?.headers["x-b"]).toBe("");
  });

  it("reads status codes and bodies as documented", async () => {
    const s = await setup();
    const answers = new Map<string, (res: ServerResponse) => void>([
      ["/empty", (res) => res.writeHead(204).end()],
      ["/text", (res) => res.writeHead(200, { "content-type": "text/plain" }).end("ok then")],
      ["/error", (res) => json(res, 503, { error: "down" })],
      ["/redirect", (res) => res.writeHead(302, { location: "http://example.com/" }).end()],
    ]);
    const server = await hookServer((req, res) => answers.get(req.url)?.(res));
    await s.write(
      "home/.dawg/settings.json",
      settings({
        UserPromptSubmit: [...answers.keys()].map((p) => ({
          hooks: [{ type: "http", url: `${server.url}${p}` }],
        })),
      }),
    );
    const hooks = await s.hooks();
    const verdict = await hooks.userPromptSubmit({ text: "hi", signal: signal() });
    // None blocks; text in a 2xx body is not context.
    expect(verdict.blocked).toBeNull();
    expect(verdict.notes).toEqual([]);
    const byPath = new Map(ran(s).map((r) => [new URL(r.hook.command).pathname, r]));
    expect(byPath.get("/empty")).toMatchObject({ outcome: "success" });
    expect(byPath.get("/text")).toMatchObject({ outcome: "error" });
    expect(byPath.get("/text")?.message).toContain("not a JSON object");
    expect(byPath.get("/error")?.message).toContain("status 503");
    expect(byPath.get("/redirect")?.message).toContain("redirect");
  });

  it("a connection that fails or a server that is too slow is a failure; onFailure block blocks", async () => {
    const s = await setup();
    const server = await hookServer(() => {
      // Never answers.
    });
    await s.write(
      "home/.dawg/settings.json",
      settings({
        PreToolUse: [
          { hooks: [{ type: "http", url: `${server.url}/slow`, timeout: 0.3 }] },
          { hooks: [{ type: "http", url: "http://127.0.0.1:9/refused" }] },
          {
            hooks: [
              { type: "http", url: `${server.url}/slow-block`, timeout: 0.3, onFailure: "block" },
            ],
          },
        ],
      }),
    );
    const hooks = await s.hooks();
    const started = Date.now();
    const verdict = await preToolUse(hooks);
    expect(Date.now() - started).toBeLessThan(3000);
    const outcomes = ran(s).map((r) => [new URL(r.hook.command).pathname, r.outcome]);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        ["/slow", "timeout"],
        ["/refused", "error"],
        ["/slow-block", "blocked"],
      ]),
    );
    expect(verdict.decision).toBe("deny");
  });

  it("runs only an address allowedHttpHookUrls lists, when a settings file sets it", async () => {
    const s = await setup();
    const server = await hookServer((_req, res) => res.writeHead(204).end());
    await s.write(
      "home/.dawg/settings.json",
      settings(
        {
          Stop: [
            { hooks: [{ type: "http", url: `${server.url}/listed` }] },
            { hooks: [{ type: "http", url: `http://localhost:${new URL(server.url).port}/not` }] },
          ],
        },
        { allowedHttpHookUrls: ["http://127.0.0.1:*"] },
      ),
    );
    const hooks = await s.hooks();
    await hooks.stop({ turnId: "t1", lastMessage: "done", signal: signal() });
    expect(server.received.map((r) => r.url)).toEqual(["/listed"]);
  });
});

/** A scripted utility model: answers each request in turn, and keeps what it was asked. */
function scriptedModel(answers: (string | Error)[]): UtilityModel & { asked: UtilityRequest[] } {
  const asked: UtilityRequest[] = [];
  return {
    contextWindow: 32_768,
    asked,
    async complete(request) {
      asked.push(request);
      const next = answers.shift() ?? "";
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe("prompt hooks", () => {
  it("puts the input in place of $ARGUMENTS, and keeps an escaped dollar", () => {
    expect(promptWithInput("Check: $ARGUMENTS. Costs \\$1.00", '{"a":1}')).toBe(
      'Check: {"a":1}. Costs $1.00',
    );
    expect(promptWithInput("No placeholder", '{"a":1}')).toBe('No placeholder\n\n{"a":1}');
    expect(promptWithInput("Literal \\$ARGUMENTS", "x")).toBe("Literal $ARGUMENTS\n\nx");
  });

  it("reads the verdict from a plain, fenced or chatty answer", () => {
    expect(readVerdict('{"ok": true}')).toEqual({ ok: true, reason: null, impossible: false });
    expect(readVerdict('```json\n{"ok": false, "reason": "Tests fail"}\n```')).toEqual({
      ok: false,
      reason: "Tests fail",
      impossible: false,
    });
    expect(
      readVerdict(
        '<think>hmm</think>Here you go: {"ok": false, "reason": "x", "impossible": true}',
      ),
    ).toEqual({ ok: false, reason: "x", impossible: true });
    expect(readVerdict("Looks fine to me")).toBeNull();
    expect(readVerdict('{"verdict": "ok"}')).toBeNull();
  });

  it("asks the model once with the prompt and input; ok false on Stop keeps the turn going", async () => {
    const s = await setup();
    await s.write(
      "home/.dawg/settings.json",
      settings({
        Stop: [
          { hooks: [{ type: "prompt", prompt: "Are all tasks done? $ARGUMENTS", model: "haiku" }] },
        ],
      }),
    );
    const model = scriptedModel(['{"ok": false, "reason": "The README is not updated yet"}']);
    const hooks = await s.hooks({ services: { model: () => model } });
    const note = await hooks.stop({ turnId: "t1", lastMessage: "All done", signal: signal() });
    expect(note).toContain("The README is not updated yet");
    expect(model.asked).toHaveLength(1);
    expect(model.asked[0]?.prompt).toContain("Are all tasks done?");
    expect(model.asked[0]?.prompt).toContain('"last_assistant_message":"All done"');
    expect(model.asked[0]?.system).toContain('{"ok": true}');
    expect(ran(s)[0]).toMatchObject({
      outcome: "blocked",
      decision: "block",
      message: "The README is not updated yet",
      hook: { type: "prompt" },
    });
  });

  it("an answer that does not parse, or a model that fails, is a non-blocking error", async () => {
    const s = await setup();
    await s.write(
      "home/.dawg/settings.json",
      settings({
        PreToolUse: [{ hooks: [{ type: "prompt", prompt: "Safe?" }] }],
      }),
    );
    const model = scriptedModel(["I think it is fine.", new Error("connection refused")]);
    const hooks = await s.hooks({ services: { model: () => model } });
    expect((await preToolUse(hooks)).decision).toBeNull();
    expect((await preToolUse(hooks)).decision).toBeNull();
    expect(ran(s).map((r) => r.outcome)).toEqual(["error", "error"]);
    expect(ran(s)[0]?.message).toContain("not the JSON the hook needs");
    expect(ran(s)[1]?.message).toContain("connection refused");
    // Without a model to ask, it fails the same way.
    const none = await setup();
    await none.write(
      "home/.dawg/settings.json",
      settings({ PreToolUse: [{ hooks: [{ type: "prompt", prompt: "Safe?" }] }] }),
    );
    const bare = await none.hooks();
    expect((await preToolUse(bare)).decision).toBeNull();
    expect(ran(none)[0]?.outcome).toBe("error");
  });

  it("ok false on PreToolUse denies the call and ends the turn, unless continueOnBlock", async () => {
    const s = await setup();
    await s.write(
      "home/.dawg/settings.json",
      settings({
        PreToolUse: [{ hooks: [{ type: "prompt", prompt: "Does it read .env?" }] }],
      }),
    );
    const hooks = await s.hooks({
      services: { model: () => scriptedModel(['{"ok": false, "reason": "It reads .env"}']) },
    });
    const verdict = await preToolUse(hooks, "cat .env");
    expect(verdict).toMatchObject({ decision: "deny", reason: "It reads .env" });
    expect(verdict.stop).toEqual({ reason: "It reads .env" });
  });
});

describe("PermissionRequest input", () => {
  it("sends the suggested rules as permission update entries, and no tool_use_id", async () => {
    const s = await setup();
    const out = path.join(s.root, "input.json");
    await s.write(
      "home/.dawg/settings.json",
      settings({
        PermissionRequest: [
          { matcher: "Bash", hooks: [{ type: "command", command: `cat > '${out}'` }] },
        ],
      }),
    );
    const hooks = await s.hooks();
    const verdict = await hooks.permissionRequest({
      turnId: "t1",
      toolCallId: "c1",
      toolName: "Bash",
      toolInput: { command: "npm test" },
      suggestions: ["Bash(npm test)", "Bash(*)", "mcp__github__get_issue"],
      signal: signal(),
    });
    expect(verdict.behavior).toBeNull();
    const { readFile } = await import("node:fs/promises");
    const sent = JSON.parse(await readFile(out, "utf8"));
    expect(sent.tool_use_id).toBeUndefined();
    expect(sent.permission_suggestions).toEqual([
      {
        type: "addRules",
        rules: [
          { toolName: "Bash", ruleContent: "npm test" },
          { toolName: "Bash" },
          { toolName: "mcp__github__get_issue" },
        ],
        behavior: "allow",
        destination: "localSettings",
      },
    ]);
    expect(ran(s)[0]).toMatchObject({ toolCallId: "c1", hook: { event: "PermissionRequest" } });
  });

  it("deny wins over allow; the allows' updates are gathered", async () => {
    const s = await setup();
    const say = (decision: unknown) => ({
      type: "command",
      command: `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } })}'`,
    });
    await s.write(
      "home/.dawg/settings.json",
      settings({
        PermissionRequest: [
          {
            hooks: [
              say({
                behavior: "allow",
                updatedPermissions: [
                  { type: "setMode", mode: "acceptEdits", destination: "session" },
                ],
              }),
            ],
          },
          { matcher: "Write", hooks: [say({ behavior: "deny", message: "No writes today" })] },
        ],
      }),
    );
    const hooks = await s.hooks();
    const call = (toolName: string) =>
      hooks.permissionRequest({
        turnId: "t1",
        toolCallId: "c1",
        toolName,
        toolInput: {},
        suggestions: [],
        signal: signal(),
      });
    expect(await call("Write")).toMatchObject({ behavior: "deny", message: "No writes today" });
    expect(await call("Bash")).toMatchObject({
      behavior: "allow",
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
  });
});

describe("agent hooks", () => {
  it("runs a read-only check with a turn limit and reads its final message", async () => {
    const s = await setup();
    await s.write(
      "home/.dawg/settings.json",
      settings({
        SubagentStop: [{ hooks: [{ type: "agent", prompt: "Did it run the tests? $ARGUMENTS" }] }],
      }),
    );
    const tasks: Parameters<HookAgents["check"]>[0][] = [];
    const agents: HookAgents = {
      async check(task) {
        tasks.push(task);
        return { text: 'I read the log.\n{"ok": false, "reason": "No test run in the log"}' };
      },
    };
    const hooks = await s.hooks({ services: { agents: () => agents } });
    const note = await hooks.subagentStop({
      agentId: "agent-1",
      agentType: "general-purpose",
      transcriptPath: "/x.jsonl",
      lastMessage: "Done",
      stopHookActive: false,
      turnId: "t1",
      signal: signal(),
    });
    expect(note).toContain("No test run in the log");
    expect(tasks[0]).toMatchObject({
      description: "SubagentStop hook check",
      maxTurns: 50,
      turnId: "t1",
    });
    expect(tasks[0]?.prompt).toContain("Did it run the tests?");
    expect(tasks[0]?.prompt).toContain('"agent_id":"agent-1"');
    expect(tasks[0]?.prompt).toContain('{"ok": true}');
  });

  it("is skipped on PermissionRequest, and fails without subagents to run on", async () => {
    const s = await setup();
    await s.write(
      "home/.dawg/settings.json",
      settings({
        PermissionRequest: [{ hooks: [{ type: "agent", prompt: "Safe?" }] }],
        PreToolUse: [{ hooks: [{ type: "agent", prompt: "Safe?" }] }],
      }),
    );
    let asked = 0;
    const hooks = await s.hooks({ services: { agents: () => null } });
    const permission = await hooks.permissionRequest({
      turnId: "t1",
      toolCallId: "c1",
      toolName: "Bash",
      toolInput: { command: "ls" },
      suggestions: [],
      signal: signal(),
    });
    expect(permission.behavior).toBeNull();
    asked += ran(s).length;
    expect(asked).toBe(0);
    expect((await preToolUse(hooks)).decision).toBeNull();
    expect(ran(s)[0]).toMatchObject({ outcome: "error" });
    expect(ran(s)[0]?.message).toContain("Subagents are not available");
  });
});

describe("mcp_tool hooks", () => {
  it("substitutes ${path} from the hook input, keeping a whole value's type", () => {
    const input = { tool_name: "Write", tool_input: { file_path: "/p/a.ts", size: 3 } };
    expect(
      substituteInput(
        {
          file_path: "${tool_input.file_path}",
          size: "${tool_input.size}",
          note: "Wrote ${tool_input.file_path} with ${tool_name}",
          missing: "${tool_input.nope}",
          nested: ["${tool_name}", { deep: "${tool_input.size}" }],
          count: 2,
        },
        input,
      ),
    ).toEqual({
      file_path: "/p/a.ts",
      size: 3,
      note: "Wrote /p/a.ts with Write",
      missing: "",
      nested: ["Write", { deep: 3 }],
      count: 2,
    });
  });

  it("calls the tool with the substituted input, and reads its text like standard output", async () => {
    const s = await setup();
    await s.write(
      "home/.dawg/settings.json",
      settings({
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
        UserPromptSubmit: [{ hooks: [{ type: "mcp_tool", server: "my_server", tool: "context" }] }],
      }),
    );
    const calls: Parameters<HookMcp["call"]>[0][] = [];
    const mcp: HookMcp = {
      async call(request) {
        calls.push(request);
        if (request.tool === "context") return { isError: false, text: "Sprint 12: auth work" };
        return {
          isError: false,
          text: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: "No secrets found",
            },
          }),
        };
      },
    };
    const hooks = await s.hooks({ services: { mcp: () => mcp } });
    const effects = await hooks.postToolUse({
      turnId: "t1",
      toolCallId: "c1",
      toolName: "Write",
      toolInput: { file_path: "/p/a.ts", content: "x" },
      toolResponse: { filePath: "/p/a.ts", success: true },
      durationMs: 4,
      signal: signal(),
    });
    expect(effects.notes.join("\n")).toContain("No secrets found");
    expect(calls[0]).toMatchObject({
      server: "my_server",
      tool: "security_scan",
      args: { file_path: "/p/a.ts" },
    });
    // It waits for a server still connecting on events that can block.
    expect(calls[0]?.waitMs).toBeGreaterThan(0);
    const prompt = await hooks.userPromptSubmit({ text: "go", signal: signal() });
    expect(prompt.notes.join("\n")).toContain("Sprint 12: auth work");
  });

  it("a tool error or a server that is not there is a failure; onFailure block blocks", async () => {
    const s = await setup();
    await s.write(
      "home/.dawg/settings.json",
      settings({
        PreToolUse: [
          { hooks: [{ type: "mcp_tool", server: "gone", tool: "check" }] },
          { hooks: [{ type: "mcp_tool", server: "policy", tool: "check", onFailure: "block" }] },
        ],
      }),
    );
    const mcp: HookMcp = {
      async call(request) {
        if (request.server === "gone")
          return { error: "the MCP server gone is not connected now." };
        return { isError: true, text: "policy store unreachable" };
      },
    };
    const hooks = await s.hooks({ services: { mcp: () => mcp } });
    const verdict = await preToolUse(hooks);
    expect(verdict.decision).toBe("deny");
    const byServer = new Map(ran(s).map((r) => [r.hook.command.split(" ")[0], r]));
    expect(byServer.get("gone")).toMatchObject({ outcome: "error" });
    expect(byServer.get("policy")).toMatchObject({ outcome: "blocked", decision: "deny" });
    expect(byServer.get("policy")?.message).toContain("policy store unreachable");
  });

  it("is skipped on SessionStart at launch, and runs after a compaction", async () => {
    const s = await setup();
    await s.write(
      "home/.dawg/settings.json",
      settings({ SessionStart: [{ hooks: [{ type: "mcp_tool", server: "kb", tool: "brief" }] }] }),
    );
    let calls = 0;
    const mcp: HookMcp = {
      async call() {
        calls += 1;
        return { isError: false, text: "Today's brief" };
      },
    };
    const hooks = await s.hooks({ services: { mcp: () => mcp } });
    await hooks.sessionStart({ source: "startup", model: null });
    expect(calls).toBe(0);
    const effects = await hooks.sessionStart({ source: "compact", model: null });
    expect(calls).toBe(1);
    expect(effects.notes.join("\n")).toContain("Today's brief");
  });
});

describe("default timeouts per handler type", () => {
  it("prompt 30 s and agent 60 s by default; command, http and mcp_tool 600 s", async () => {
    const s = await setup();
    await s.write(
      "home/.dawg/settings.json",
      settings({
        PreToolUse: [
          { hooks: [{ type: "prompt", prompt: "slow?" }] },
          { hooks: [{ type: "agent", prompt: "slow?" }] },
        ],
      }),
    );
    const slow = <T>(): Promise<T> => new Promise(() => {});
    const hooks = await s.hooks({
      // The defaults, scaled down so the test is quick; the ratio is what is checked.
      timeouts: { promptMs: 200, agentMs: 400 },
      services: {
        model: () => ({ contextWindow: 1, complete: () => slow() }),
        agents: () => ({ check: () => slow() }),
      },
    });
    await preToolUse(hooks);
    const byType = new Map(ran(s).map((r) => [r.hook.type, r]));
    expect(byType.get("prompt")).toMatchObject({ outcome: "timeout" });
    expect(byType.get("agent")).toMatchObject({ outcome: "timeout" });
    expect(byType.get("prompt")?.durationMs ?? 0).toBeLessThan(
      byType.get("agent")?.durationMs ?? 0,
    );
    const { DEFAULT_HOOK_TIMEOUTS } = await import("./session-hooks.ts");
    expect(DEFAULT_HOOK_TIMEOUTS).toMatchObject({
      commandMs: 600_000,
      promptMs: 30_000,
      agentMs: 60_000,
    });
  });

  it("a handler's own timeout wins over the type's default", async () => {
    const s = await setup();
    await s.write(
      "home/.dawg/settings.json",
      settings({ PreToolUse: [{ hooks: [{ type: "prompt", prompt: "slow?", timeout: 0.15 }] }] }),
    );
    const hooks = await s.hooks({
      services: { model: () => ({ contextWindow: 1, complete: () => new Promise(() => {}) }) },
    });
    const started = Date.now();
    await preToolUse(hooks);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(ran(s)[0]?.outcome).toBe("timeout");
  });
});

describe("consent for project hooks of every type", () => {
  const projectHooks = (url: string) =>
    settings({
      PreToolUse: [
        {
          hooks: [
            { type: "http", url },
            { type: "prompt", prompt: "Safe? $ARGUMENTS" },
            { type: "agent", prompt: "Check it." },
            { type: "mcp_tool", server: "policy", tool: "check" },
          ],
        },
      ],
    });

  it("runs none until the person approves, then all of them", async () => {
    const s = await setup();
    const server = await hookServer((_req, res) => res.writeHead(204).end());
    await s.write("project/.claude/settings.json", projectHooks(server.url));
    let modelCalls = 0;
    let agentCalls = 0;
    let mcpCalls = 0;
    const services: HookServices = {
      model: () => ({
        contextWindow: 1,
        complete: async () => {
          modelCalls += 1;
          return '{"ok": true}';
        },
      }),
      agents: () => ({
        check: async () => {
          agentCalls += 1;
          return { text: '{"ok": true}' };
        },
      }),
      mcp: () => ({
        call: async () => {
          mcpCalls += 1;
          return { isError: false, text: "" };
        },
      }),
    };
    const store = createTrustStore({ storeRoot: s.store, homeDir: s.home });
    const held = await s.hooks({ trust: store, services });
    await preToolUse(held);
    expect([server.received.length, modelCalls, agentCalls, mcpCalls]).toEqual([0, 0, 0, 0]);
    expect(s.events.filter((e) => e.event === "hook.skipped")).toHaveLength(1);

    const approval = await store.approval(s.project);
    expect(approval?.items.map((i) => i.notes[0])).toEqual([
      expect.stringContaining(`Sends each event to ${server.url}`),
      expect.stringContaining("Asks the model"),
      expect.stringContaining("Starts a subagent"),
      expect.stringContaining("Calls the tool check of the MCP server policy"),
    ]);
    await store.decide(s.project, approval?.hash ?? "", true);
    const approved = await s.hooks({ trust: store, services });
    await preToolUse(approved);
    expect([server.received.length, modelCalls, agentCalls, mcpCalls]).toEqual([1, 1, 1, 1]);
  });

  it("a change to any field of a handler asks again", async () => {
    const s = await setup();
    const base = (handler: Record<string, unknown>) =>
      hookId({
        event: "PreToolUse",
        matcher: null,
        source: {
          path: path.join(s.project, ".claude", "settings.json"),
          origin: "claude",
          scope: "project",
        },
        handler: { raw: handler } as never,
      });
    const variants: [Record<string, unknown>, Record<string, unknown>][] = [
      [
        { type: "http", url: "http://a/x" },
        { type: "http", url: "http://b/x" },
      ],
      [
        { type: "http", url: "http://a/x", headers: { A: "$X" } },
        { type: "http", url: "http://a/x", headers: { A: "$Y" } },
      ],
      [
        { type: "http", url: "http://a/x", allowedEnvVars: [] },
        { type: "http", url: "http://a/x", allowedEnvVars: ["GITHUB_TOKEN"] },
      ],
      [
        { type: "prompt", prompt: "a" },
        { type: "prompt", prompt: "b" },
      ],
      [
        { type: "prompt", prompt: "a" },
        { type: "prompt", prompt: "a", model: "opus" },
      ],
      [
        { type: "mcp_tool", server: "a", tool: "t" },
        { type: "mcp_tool", server: "b", tool: "t" },
      ],
      [
        { type: "mcp_tool", server: "a", tool: "t" },
        { type: "mcp_tool", server: "a", tool: "u" },
      ],
      [
        { type: "mcp_tool", server: "a", tool: "t", input: { x: 1 } },
        { type: "mcp_tool", server: "a", tool: "t", input: { x: 2 } },
      ],
    ];
    for (const [before, after] of variants) expect(base(before)).not.toBe(base(after));

    // And end to end: changing an approved project's hook URL holds the hook back again.
    const server = await hookServer((_req, res) => res.writeHead(204).end());
    await s.write(
      "project/.claude/settings.json",
      settings({ Stop: [{ hooks: [{ type: "http", url: `${server.url}/one` }] }] }),
    );
    const store = createTrustStore({ storeRoot: s.store, homeDir: s.home });
    const approval = await store.approval(s.project);
    await store.decide(s.project, approval?.hash ?? "", true);
    await s.write(
      "project/.claude/settings.json",
      settings({ Stop: [{ hooks: [{ type: "http", url: `${server.url}/two` }] }] }),
    );
    const hooks = await s.hooks({ trust: store });
    await hooks.stop({ turnId: "t1", lastMessage: "done", signal: signal() });
    expect(server.received).toEqual([]);
  });
});
