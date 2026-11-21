import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { TASKS } from "../__fixtures__/paths.ts";
import { loadTask } from "../task.ts";
import {
  buildClaudeCodeLaunch,
  buildCommandLaunch,
  buildDawgLaunch,
  buildOpencodeLaunch,
  buildPiLaunch,
  createAdapter,
  DAWG_CLI_ENTRY,
  launchEnv,
  type RunContext,
  unmetRequirements,
} from "./index.ts";

const task = loadTask(join(TASKS, "edit-greeting"));
const PROMPT = `Fix "it" -- and don't $(rm -rf /) anything`;

function ctx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    task,
    workspace: "/w/workspace",
    prompt: PROMPT,
    homeDir: "/w/home",
    tmpDir: "/w/tmp",
    artifactsDir: "/w/artifacts",
    taskDir: task.dir,
    endpoint: {
      openaiBaseUrl: "http://127.0.0.1:4567/v1",
      anthropicBaseUrl: "http://127.0.0.1:4567",
      apiKey: "dawg-eval-dummy-key",
      model: "Qwen/Qwen3.8-27B",
    },
    timeoutMs: 1000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("command adapter", () => {
  test("substitutes placeholders per word; the prompt stays one argument", () => {
    const spec = buildCommandLaunch(
      ctx(),
      `my-agent --base {openai_base_url} --model={model} -p {prompt} --file "{prompt_file}"`,
    );
    expect(spec.command).toBe("my-agent");
    expect(spec.args).toEqual([
      "--base",
      "http://127.0.0.1:4567/v1",
      "--model=Qwen/Qwen3.8-27B",
      "-p",
      PROMPT,
      "--file",
      "/w/artifacts/prompt.txt",
    ]);
    expect(spec.files).toEqual({ "/w/artifacts/prompt.txt": PROMPT });
    expect(spec.env).toMatchObject({
      OPENAI_BASE_URL: "http://127.0.0.1:4567/v1",
      OPENAI_API_KEY: "dawg-eval-dummy-key",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4567",
      ANTHROPIC_AUTH_TOKEN: "dawg-eval-dummy-key",
      DAWG_EVAL_MODEL: "Qwen/Qwen3.8-27B",
    });
  });

  test("unknown placeholders are left alone; all known ones resolve", () => {
    const spec = buildCommandLaunch(
      ctx(),
      "x {workspace} {home} {artifacts} {anthropic_base_url} {api_key} {nope}",
    );
    expect(spec.args).toEqual([
      "/w/workspace",
      "/w/home",
      "/w/artifacts",
      "http://127.0.0.1:4567",
      "dawg-eval-dummy-key",
      "{nope}",
    ]);
  });

  test("requires a template and an endpoint", () => {
    expect(() => createAdapter("command")).toThrow(/--agent-cmd/);
    expect(() => buildCommandLaunch(ctx({ endpoint: null }), "x")).toThrow(/endpoint/);
    expect(() => buildCommandLaunch(ctx(), "   ")).toThrow(/empty/);
  });
});

describe("opencode adapter (unverified against the real binary)", () => {
  test("writes a provider config in the throwaway HOME and runs headless", () => {
    const spec = buildOpencodeLaunch(ctx());
    expect(spec.command).toBe("opencode");
    expect(spec.args).toEqual([
      "run",
      "--standalone",
      "--auto",
      "--format",
      "json",
      "--model",
      "dawg-eval/qwen-qwen3.8-27b",
      PROMPT,
    ]);
    const path = "/w/home/.config/opencode/opencode.json";
    expect(Object.keys(spec.files)).toEqual([path]);
    expect(JSON.parse(spec.files[path] as string)).toEqual({
      $schema: "https://opencode.ai/config.json",
      model: "dawg-eval/qwen-qwen3.8-27b",
      update: "disable",
      providers: {
        "dawg-eval": {
          name: "dawg eval proxy",
          env: ["DAWG_EVAL_API_KEY"],
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: "http://127.0.0.1:4567/v1", apiKey: "{env:DAWG_EVAL_API_KEY}" },
          models: { "qwen-qwen3.8-27b": { name: "Qwen/Qwen3.8-27B", modelID: "Qwen/Qwen3.8-27B" } },
        },
      },
    });
    expect(spec.env).toEqual({ DAWG_EVAL_API_KEY: "dawg-eval-dummy-key" });
    // The config file lands where XDG_CONFIG_HOME points.
    expect(launchEnv(ctx(), spec).XDG_CONFIG_HOME).toBe("/w/home/.config");
    expect(spec.transcriptPath).toBe("/w/artifacts/agent.stdout.log");
  });
});

describe("pi adapter (unverified against the real binary)", () => {
  test("writes models.json under PI_CODING_AGENT_DIR and runs in JSON mode", () => {
    const spec = buildPiLaunch(ctx(), "/opt/pi");
    expect(spec.command).toBe("/opt/pi");
    expect(spec.args).toEqual([
      "--mode",
      "json",
      "--no-session",
      "--provider",
      "dawg-eval",
      "--model",
      "Qwen/Qwen3.8-27B",
      PROMPT,
    ]);
    expect(spec.env).toEqual({
      DAWG_EVAL_API_KEY: "dawg-eval-dummy-key",
      PI_CODING_AGENT_DIR: "/w/home/.pi/agent",
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    });
    expect(JSON.parse(spec.files["/w/home/.pi/agent/models.json"] as string)).toEqual({
      providers: {
        "dawg-eval": {
          name: "dawg eval proxy",
          baseUrl: "http://127.0.0.1:4567/v1",
          api: "openai-completions",
          apiKey: "$DAWG_EVAL_API_KEY",
          models: [{ id: "Qwen/Qwen3.8-27B", name: "Qwen/Qwen3.8-27B" }],
        },
      },
    });
  });
});

describe("claude-code adapter (unverified against the real binary)", () => {
  test("uses -p with the Anthropic-format proxy URL and a dummy bearer token", () => {
    const spec = buildClaudeCodeLaunch(ctx());
    expect(spec.command).toBe("claude");
    expect(spec.args).toEqual([
      "-p",
      PROMPT,
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "Qwen/Qwen3.8-27B",
      "--dangerously-skip-permissions",
    ]);
    expect(spec.env).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4567",
      ANTHROPIC_AUTH_TOKEN: "dawg-eval-dummy-key",
      ANTHROPIC_MODEL: "Qwen/Qwen3.8-27B",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "Qwen/Qwen3.8-27B",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "Qwen/Qwen3.8-27B",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "Qwen/Qwen3.8-27B",
      CLAUDE_CONFIG_DIR: "/w/home/.claude",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    });
    const env = launchEnv(ctx(), spec);
    expect(env.HOME).toBe("/w/home");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("dawg adapter", () => {
  test("runs this checkout's CLI with the headless flags, the proxy and the dummy key", () => {
    const spec = buildDawgLaunch(ctx());
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual([
      DAWG_CLI_ENTRY,
      "-p",
      PROMPT,
      "--output-format",
      "stream-json",
      "--model",
      "Qwen/Qwen3.8-27B",
      "--endpoint",
      "http://127.0.0.1:4567/v1",
      "--permission-mode",
      "bypassPermissions",
      "--max-turns",
      "200",
      "--cwd",
      "/w/workspace",
    ]);
    expect(existsSync(DAWG_CLI_ENTRY)).toBe(true);
    expect(DAWG_CLI_ENTRY.endsWith(join("packages", "cli", "src", "main.ts"))).toBe(true);
    expect(spec.env).toEqual({
      DAWG_API_KEY: "dawg-eval-dummy-key",
      DAWG_HOME: "/w/artifacts/dawg-home",
    });
    expect(spec.files).toEqual({});
    expect(spec.transcriptPath).toBe("/w/artifacts/agent.stdout.log");
    const env = launchEnv(ctx(), spec);
    expect(env.HOME).toBe("/w/home");
    expect(env.DAWG_API_KEY).toBe("dawg-eval-dummy-key");
  });

  test("an --agent-bin replaces node and the entry point", () => {
    const spec = buildDawgLaunch(ctx(), "/opt/dawg");
    expect(spec.command).toBe("/opt/dawg");
    expect(spec.args[0]).toBe("-p");
  });
});

describe("registry and features", () => {
  test("creates every adapter and rejects unknown ids", () => {
    for (const id of ["reference", "noop", "opencode", "pi", "claude-code", "dawg"]) {
      expect(createAdapter(id).id).toBe(id);
    }
    expect(createAdapter("command", { agentCmd: "x" }).id).toBe("command");
    expect(() => createAdapter("cursor")).toThrow(/unknown agent/);
  });

  test("requires are matched against features; * matches everything", () => {
    const mcpTask = loadTask(join(TASKS, "needs-mcp"));
    expect(unmetRequirements(createAdapter("pi"), mcpTask)).toEqual(["mcp"]);
    expect(unmetRequirements(createAdapter("pi", { features: ["mcp"] }), mcpTask)).toEqual([]);
    expect(unmetRequirements(createAdapter("claude-code"), mcpTask)).toEqual([]);
    expect(unmetRequirements(createAdapter("reference"), mcpTask)).toEqual([]);
    expect(unmetRequirements(createAdapter("pi"), task)).toEqual([]);
  });

  test("only model-backed adapters need an endpoint", () => {
    expect(createAdapter("reference").needsEndpoint).toBe(false);
    expect(createAdapter("noop").needsEndpoint).toBe(false);
    expect(createAdapter("opencode").needsEndpoint).toBe(true);
  });
});
