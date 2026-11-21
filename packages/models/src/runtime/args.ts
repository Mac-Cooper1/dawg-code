/**
 * Pure construction of the `llama-server` command line. Every flag here was checked against
 * `llama-server --help` of the pinned build (b12359) and the server README at that tag.
 */

/** The runtime only ever listens on loopback. Not configurable on purpose. */
export const RUNTIME_HOST = "127.0.0.1";

export interface ReasoningSettings {
  /** `--reasoning`: whether the template is asked to think. Server default: auto. */
  mode?: "on" | "off" | "auto";
  /** `--reasoning-format`: how thoughts are returned. Server default: auto. */
  format?: "none" | "deepseek" | "deepseek-legacy" | "auto";
  /** `--reasoning-budget`: token budget for thinking; -1 unrestricted, 0 ends at once. */
  budget?: number;
  /** `--reasoning-effort`: level handed to the chat template, e.g. "high". */
  effort?: string;
  /** `--reasoning-preserve` / `--no-reasoning-preserve`. Server default: on. */
  preserve?: boolean;
}

/** Settings that come from the model's profile (cache sizes, reasoning) and the app. */
export interface RuntimeSettings {
  /** `--cache-ram`: host-memory prompt cache size in MiB (-1 no limit, 0 disabled). */
  cacheRamMiB: number;
  /** `--ctx-checkpoints`: context checkpoints kept per slot. */
  ctxCheckpoints: number;
  /** `--checkpoint-min-step`: minimum spacing between checkpoints, in tokens. */
  checkpointMinStep: number;
  reasoning?: ReasoningSettings;
  /** `--kv-unified` / `--no-kv-unified`. Omitted leaves the server default. */
  kvUnified?: boolean;
  /** `--kv-unified-per-slot`: context limit per slot when the KV buffer is unified. */
  kvUnifiedPerSlot?: number;
  /**
   * `--sleep-idle-seconds`: idle unload. The server frees the model and its KV cache after this
   * many idle seconds and reloads it on the next request. Omitted means never (the default).
   */
  idleUnloadSeconds?: number;
  /** `--timeout`: server read/write timeout in seconds. */
  timeoutSeconds?: number;
  /** `--alias`: the model id the server reports and accepts. Defaults to the file path. */
  alias?: string;
  /** `--offline`: never touch the network. Default true. */
  offline?: boolean;
  /**
   * Extra flags from a model profile (for example a chat template override). Flags that would
   * weaken the security baseline or fight the supervisor are rejected.
   */
  extraArgs?: readonly string[];
}

export interface LaunchPaths {
  /** The 0600 file holding this launch's API key. */
  apiKeyFile: string;
  slotSaveDir: string;
  /** llama.cpp's own log file (`--log-file`); it is truncated at each launch. */
  logFile: string;
}

export interface LaunchModel {
  path: string;
  /** Vision projector (`--mmproj`). */
  projectorPath?: string;
}

export interface LaunchInput {
  model: LaunchModel;
  /** Total context passed to `-c`. The server divides it between slots; read /props for the real per-slot size. */
  contextSize: number;
  /** Parallel slots (`-np`): one for the main agent, plus subagent slots. */
  slots: number;
  port: number;
  settings: RuntimeSettings;
  paths: LaunchPaths;
}

/** Flags the supervisor owns or that must never be set from a profile. */
const RESERVED_FLAGS = new Set([
  "-m",
  "--model",
  "-mu",
  "--model-url",
  "-hf",
  "-hfr",
  "--hf-repo",
  "-hff",
  "--hf-file",
  "--host",
  "--port",
  "--api-key",
  "--api-key-file",
  "--path",
  "--api-prefix",
  "--ui",
  "--webui",
  "--no-ui",
  "--no-webui",
  "--props",
  "--slot-save-path",
  "--log-file",
  "--log-disable",
  "-c",
  "--ctx-size",
  "-np",
  "--parallel",
  "-ngl",
  "--gpu-layers",
  "--n-gpu-layers",
  "-mm",
  "--mmproj",
  "-mmu",
  "--mmproj-url",
  "--tools",
  "--allow-unauthenticated-tools",
  "--mcp-servers-config",
  "--mcp-servers-json",
  "--ui-mcp-proxy",
  "--webui-mcp-proxy",
  "--media-path",
  "--media-allow-private-urls",
  "--cors-origins",
  "--ssl-key-file",
  "--ssl-cert-file",
  "--models-dir",
  "--models-preset",
]);

export class LaunchArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchArgsError";
  }
}

function positiveInt(name: string, value: number): string {
  if (!Number.isInteger(value) || value <= 0) {
    throw new LaunchArgsError(`${name} must be a positive integer, got ${value}`);
  }
  return String(value);
}

function integer(name: string, value: number, min: number): string {
  if (!Number.isInteger(value) || value < min) {
    throw new LaunchArgsError(`${name} must be an integer >= ${min}, got ${value}`);
  }
  return String(value);
}

export function buildLaunchArgs(input: LaunchInput): string[] {
  const { model, settings, paths } = input;
  if (!model.path) throw new LaunchArgsError("model path is required");
  if (!Number.isInteger(input.port) || input.port <= 0 || input.port > 65535) {
    throw new LaunchArgsError(`port must be 1-65535, got ${input.port}`);
  }
  const args = [
    "-m",
    model.path,
    "--host",
    RUNTIME_HOST,
    "--port",
    String(input.port),
    "--api-key-file",
    paths.apiKeyFile,
    "-c",
    positiveInt("contextSize", input.contextSize),
    "-np",
    positiveInt("slots", input.slots),
    "-ngl",
    "all",
    // The spec's `--no-webui` still works on b12359 but the binary logs it as deprecated.
    "--no-ui",
    "--slot-save-path",
    paths.slotSaveDir,
    "--cache-ram",
    integer("cacheRamMiB", settings.cacheRamMiB, -1),
    "--ctx-checkpoints",
    integer("ctxCheckpoints", settings.ctxCheckpoints, 0),
    "--checkpoint-min-step",
    integer("checkpointMinStep", settings.checkpointMinStep, 0),
    "--log-file",
    paths.logFile,
  ];
  if (model.projectorPath) args.push("--mmproj", model.projectorPath);
  const reasoning = settings.reasoning;
  if (reasoning?.mode) args.push("--reasoning", reasoning.mode);
  if (reasoning?.format) args.push("--reasoning-format", reasoning.format);
  if (reasoning?.budget !== undefined) {
    args.push("--reasoning-budget", integer("reasoning.budget", reasoning.budget, -1));
  }
  if (reasoning?.effort) {
    if (!/^[a-z]+$/.test(reasoning.effort)) {
      throw new LaunchArgsError(
        `reasoning.effort must be a lowercase word, got ${reasoning.effort}`,
      );
    }
    args.push("--reasoning-effort", reasoning.effort);
  }
  if (reasoning?.preserve !== undefined) {
    args.push(reasoning.preserve ? "--reasoning-preserve" : "--no-reasoning-preserve");
  }
  if (settings.kvUnified !== undefined) {
    args.push(settings.kvUnified ? "--kv-unified" : "--no-kv-unified");
  }
  if (settings.kvUnifiedPerSlot !== undefined) {
    args.push("--kv-unified-per-slot", positiveInt("kvUnifiedPerSlot", settings.kvUnifiedPerSlot));
  }
  if (settings.idleUnloadSeconds !== undefined) {
    args.push("--sleep-idle-seconds", positiveInt("idleUnloadSeconds", settings.idleUnloadSeconds));
  }
  if (settings.timeoutSeconds !== undefined) {
    args.push("--timeout", positiveInt("timeoutSeconds", settings.timeoutSeconds));
  }
  if (settings.alias) args.push("--alias", settings.alias);
  if (settings.offline !== false) args.push("--offline");
  for (const arg of settings.extraArgs ?? []) {
    const flag = arg.split("=", 1)[0] ?? arg;
    if (RESERVED_FLAGS.has(flag)) {
      throw new LaunchArgsError(
        `${flag} is managed by the supervisor and cannot be passed as an extra argument`,
      );
    }
  }
  args.push(...(settings.extraArgs ?? []));
  return args;
}
