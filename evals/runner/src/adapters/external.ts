import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitArgs } from "../proc.ts";
import { executeLaunch, requireEndpoint, slugify } from "./launch.ts";
import type { AgentAdapter, LaunchSpec, RunContext } from "./types.ts";

export interface ExternalAdapterOptions {
  /** Override the executable (default: the tool's usual command name on PATH). */
  bin?: string;
  /** Reasoning effort level to run with. Only the dawg adapter passes it on. */
  effort?: string;
  /** Extra features to claim, for example when testing a newer build of the tool. */
  features?: readonly string[];
}

function adapter(
  id: string,
  features: readonly string[],
  build: (ctx: RunContext) => LaunchSpec,
): AgentAdapter {
  return {
    id,
    features: new Set(features),
    needsEndpoint: true,
    run: (ctx) => executeLaunch(ctx, build(ctx)),
  };
}

/** Name of the env var through which adapters hand the dummy key to a tool's config file. */
export const KEY_ENV = "DAWG_EVAL_API_KEY";

// ---------------------------------------------------------------------------------------------
// command: the escape hatch for any CLI agent.
// ---------------------------------------------------------------------------------------------

export const COMMAND_PLACEHOLDERS = [
  "prompt",
  "prompt_file",
  "workspace",
  "home",
  "artifacts",
  "openai_base_url",
  "anthropic_base_url",
  "model",
  "api_key",
] as const;

/**
 * Builds a launch from a command template such as
 * `my-agent --model {model} --base-url {openai_base_url} {prompt}`.
 *
 * The template is split into words first (shell-style quoting, no expansion), then placeholders are
 * substituted inside each word, so a prompt with spaces or quotes stays one argument and is never
 * interpreted by a shell. Wrap the template in `bash -c '...'` if you need a shell. The same values
 * are also exported as environment variables (OPENAI_BASE_URL, OPENAI_API_KEY, ANTHROPIC_BASE_URL,
 * ANTHROPIC_AUTH_TOKEN, DAWG_EVAL_*), and the prompt is written to `{prompt_file}`.
 */
export function buildCommandLaunch(ctx: RunContext, template: string): LaunchSpec {
  const ep = requireEndpoint(ctx, "command");
  const promptFile = join(ctx.artifactsDir, "prompt.txt");
  const values: Record<(typeof COMMAND_PLACEHOLDERS)[number], string> = {
    prompt: ctx.prompt,
    prompt_file: promptFile,
    workspace: ctx.workspace,
    home: ctx.homeDir,
    artifacts: ctx.artifactsDir,
    openai_base_url: ep.openaiBaseUrl,
    anthropic_base_url: ep.anthropicBaseUrl,
    model: ep.model,
    api_key: ep.apiKey,
  };
  const words = splitArgs(template);
  if (words.length === 0) throw new Error("command adapter: empty --agent-cmd template");
  const subst = (w: string) =>
    w.replace(/\{([a-z_]+)\}/g, (m, name: string) =>
      name in values ? values[name as keyof typeof values] : m,
    );
  const [command, ...args] = words.map(subst) as [string, ...string[]];
  return {
    command,
    args,
    env: {
      OPENAI_BASE_URL: ep.openaiBaseUrl,
      OPENAI_API_KEY: ep.apiKey,
      ANTHROPIC_BASE_URL: ep.anthropicBaseUrl,
      ANTHROPIC_AUTH_TOKEN: ep.apiKey,
      DAWG_EVAL_MODEL: ep.model,
      DAWG_EVAL_WORKSPACE: ctx.workspace,
      DAWG_EVAL_PROMPT_FILE: promptFile,
      [KEY_ENV]: ep.apiKey,
    },
    files: { [promptFile]: ctx.prompt },
  };
}

export function commandAdapter(template: string, opts: ExternalAdapterOptions = {}): AgentAdapter {
  splitArgs(template); // Fail fast on bad quoting.
  return adapter("command", opts.features ?? [], (ctx) => buildCommandLaunch(ctx, template));
}

// ---------------------------------------------------------------------------------------------
// opencode
// UNVERIFIED against the real binary: built from the public docs on 2026-11-20.
//   https://opencode.ai/docs/cli/commands.md  (`opencode run`, --model, --format json, --auto,
//                                               --standalone)
//   https://opencode.ai/docs/providers/       (`providers.<id>` with `package`, `settings.baseURL`,
//                                               `env`, `models`, `modelID`; `{env:VAR}`)
//   https://opencode.ai/docs/config/          (global config at ~/.config/opencode/opencode.json,
//                                               `update: "disable"`)
// ---------------------------------------------------------------------------------------------

export const OPENCODE_PROVIDER_ID = "dawg-eval";

export function buildOpencodeLaunch(ctx: RunContext, bin = "opencode"): LaunchSpec {
  const ep = requireEndpoint(ctx, "opencode");
  // Model names may contain "/" (e.g. "Qwen/Qwen3.8-27B"), which would break the
  // "provider/model" reference, so the config key is a slug and `modelID` carries the real name.
  const modelKey = slugify(ep.model);
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `${OPENCODE_PROVIDER_ID}/${modelKey}`,
    update: "disable",
    providers: {
      [OPENCODE_PROVIDER_ID]: {
        name: "dawg eval proxy",
        env: [KEY_ENV],
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: ep.openaiBaseUrl,
          apiKey: `{env:${KEY_ENV}}`,
        },
        models: {
          [modelKey]: { name: ep.model, modelID: ep.model },
        },
      },
    },
  };
  // Global config inside the throwaway HOME (XDG_CONFIG_HOME is set to $HOME/.config), so nothing
  // is written into the workspace and the user's real config is never read.
  const configPath = join(ctx.homeDir, ".config", "opencode", "opencode.json");
  return {
    command: bin,
    args: [
      "run",
      "--standalone",
      "--auto",
      "--format",
      "json",
      "--model",
      `${OPENCODE_PROVIDER_ID}/${modelKey}`,
      ctx.prompt,
    ],
    env: { [KEY_ENV]: ep.apiKey },
    files: { [configPath]: `${JSON.stringify(config, null, 2)}\n` },
    // --format json prints NDJSON events to stdout: that is the transcript.
    transcriptPath: join(ctx.artifactsDir, "agent.stdout.log"),
  };
}

export function opencodeAdapter(opts: ExternalAdapterOptions = {}): AgentAdapter {
  // OpenCode reads project skills; MCP needs config we do not generate yet.
  return adapter("opencode", ["skills", ...(opts.features ?? [])], (ctx) =>
    buildOpencodeLaunch(ctx, opts.bin),
  );
}

// ---------------------------------------------------------------------------------------------
// pi
// UNVERIFIED against the real binary: built from the public docs on 2026-11-20.
//   https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md
//     (--mode json, --no-session, --provider, --model)
//   https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md
//   https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models-configuration.md
//     (models.json: providers.<id>.baseUrl / api "openai-completions" / apiKey "$VAR" / models[])
//   https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/environment-variables.md
//     (PI_CODING_AGENT_DIR, PI_OFFLINE, PI_SKIP_VERSION_CHECK, PI_TELEMETRY)
// ---------------------------------------------------------------------------------------------

export const PI_PROVIDER_ID = "dawg-eval";

export function buildPiLaunch(ctx: RunContext, bin = "pi"): LaunchSpec {
  const ep = requireEndpoint(ctx, "pi");
  const agentDir = join(ctx.homeDir, ".pi", "agent");
  const models = {
    providers: {
      [PI_PROVIDER_ID]: {
        name: "dawg eval proxy",
        baseUrl: ep.openaiBaseUrl,
        api: "openai-completions",
        apiKey: `$${KEY_ENV}`,
        models: [{ id: ep.model, name: ep.model }],
      },
    },
  };
  return {
    command: bin,
    args: [
      "--mode",
      "json",
      "--no-session",
      "--provider",
      PI_PROVIDER_ID,
      "--model",
      ep.model,
      ctx.prompt,
    ],
    env: {
      [KEY_ENV]: ep.apiKey,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
    files: { [join(agentDir, "models.json")]: `${JSON.stringify(models, null, 2)}\n` },
    // --mode json writes JSONL events to stdout: that is the transcript.
    transcriptPath: join(ctx.artifactsDir, "agent.stdout.log"),
  };
}

export function piAdapter(opts: ExternalAdapterOptions = {}): AgentAdapter {
  return adapter("pi", [...(opts.features ?? [])], (ctx) => buildPiLaunch(ctx, opts.bin));
}

// ---------------------------------------------------------------------------------------------
// claude-code
// UNVERIFIED against the real binary: built from the public docs on 2026-11-20.
//   https://code.claude.com/docs/en/headless   (-p, --output-format stream-json + --verbose)
//   https://code.claude.com/docs/en/llm-gateway-connect.md
//     (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)
//   https://code.claude.com/docs/en/env-vars.md
//     (ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL,
//      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, CLAUDE_CONFIG_DIR)
//   https://code.claude.com/docs/en/cli-reference.md  (--dangerously-skip-permissions)
// Not --bare: bare mode skips CLAUDE.md, skills and .mcp.json, which the skill and MCP tasks need.
// The throwaway HOME keeps the user's own ~/.claude out instead.
// ---------------------------------------------------------------------------------------------

export function buildClaudeCodeLaunch(ctx: RunContext, bin = "claude"): LaunchSpec {
  const ep = requireEndpoint(ctx, "claude-code");
  return {
    command: bin,
    args: [
      "-p",
      ctx.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      ep.model,
      "--dangerously-skip-permissions",
    ],
    env: {
      ANTHROPIC_BASE_URL: ep.anthropicBaseUrl,
      ANTHROPIC_AUTH_TOKEN: ep.apiKey,
      ANTHROPIC_MODEL: ep.model,
      // Route every alias (and background work such as titles) to the model under test.
      ANTHROPIC_DEFAULT_OPUS_MODEL: ep.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: ep.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: ep.model,
      CLAUDE_CONFIG_DIR: join(ctx.homeDir, ".claude"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    },
    files: {},
    transcriptPath: join(ctx.artifactsDir, "agent.stdout.log"),
  };
}

export function claudeCodeAdapter(opts: ExternalAdapterOptions = {}): AgentAdapter {
  return adapter("claude-code", ["mcp", "skills", ...(opts.features ?? [])], (ctx) =>
    buildClaudeCodeLaunch(ctx, opts.bin),
  );
}

// ---------------------------------------------------------------------------------------------
// dawg: our own command-line tool (packages/cli, README there), run from this checkout.
// `-p` with stream-json output (every protocol event, one per line: the transcript), the proxy as
// `--endpoint` and the dummy key in DAWG_API_KEY, which the CLI reads from the environment only
// and keeps out of the commands the agent runs. Same freedom as the other harnesses
// (--dangerously-skip-permissions, --auto): bypassPermissions inside the task's throwaway
// workspace. Sessions are stored under the run's artefacts, so the transcript survives the run.
// ---------------------------------------------------------------------------------------------

/** The CLI's entry point in this checkout, run with the runner's own Node. */
export const DAWG_CLI_ENTRY = fileURLToPath(
  new URL("../../../../packages/cli/src/main.ts", import.meta.url),
);

/** Model requests one eval turn may make: the engine's default limit, stated explicitly. */
export const DAWG_EVAL_MAX_TURNS = 200;

export function buildDawgLaunch(ctx: RunContext, bin?: string, effort?: string): LaunchSpec {
  const ep = requireEndpoint(ctx, "dawg");
  const [command, prefix] =
    bin === undefined ? [process.execPath, [DAWG_CLI_ENTRY]] : [bin, [] as string[]];
  return {
    command,
    args: [
      ...prefix,
      "-p",
      ctx.prompt,
      "--output-format",
      "stream-json",
      "--model",
      ep.model,
      "--endpoint",
      ep.openaiBaseUrl,
      "--permission-mode",
      "bypassPermissions",
      "--max-turns",
      String(DAWG_EVAL_MAX_TURNS),
      "--cwd",
      ctx.workspace,
      ...(effort === undefined ? [] : ["--effort", effort]),
    ],
    env: {
      DAWG_API_KEY: ep.apiKey,
      DAWG_HOME: join(ctx.artifactsDir, "dawg-home"),
    },
    files: {},
    transcriptPath: join(ctx.artifactsDir, "agent.stdout.log"),
  };
}

export function dawgAdapter(opts: ExternalAdapterOptions = {}): AgentAdapter {
  return adapter("dawg", [...(opts.features ?? [])], (ctx) =>
    buildDawgLaunch(ctx, opts.bin, opts.effort),
  );
}
