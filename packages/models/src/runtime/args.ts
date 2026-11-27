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
  /**
   * `-c`: the KV cache in tokens. Without a unified cache the server divides it between slots;
   * with one (see `twoSlotLayout`) the slots share it, each capped by `kvUnifiedPerSlot`. Read
   * /props for the real per-slot size.
   */
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

/** Tokens of the shared cache kept for side requests (titles), beside the conversation's window. */
export const UTILITY_CONTEXT_RESERVE = 8192;

/** How dawg lays out llama-server's slots and cache for one model. */
export interface SlotLayout {
  /** `-c`: the cache both slots share. This many tokens of cache is what memory must hold. */
  contextSize: number;
  /** `-np`: one slot for conversations, one for side requests. */
  slots: 2;
  /** `--kv-unified` and `--kv-unified-per-slot`: each slot may use up to the window. */
  settings: { kvUnified: true; kvUnifiedPerSlot: number };
  /** The slot ids the engine schedules: conversations take turns on one, side requests use the other. */
  slotIds: { conversation: number[]; utility: number[] };
}

/**
 * The two-slot layout every launch uses: slot 0 for conversations, slot 1 for side requests
 * such as titles, so those never evict a conversation's cache. The cache is unified: it holds
 * `window` tokens for the conversation plus `reserve` for side requests, and each slot is capped
 * at `window`, so /props reports `window` as the per-slot context. Checked on b12359:
 * `-c 5120 -np 2 --kv-unified --kv-unified-per-slot 4096` serves two slots of 4096.
 */
export function twoSlotLayout(
  window: number,
  reserve: number = UTILITY_CONTEXT_RESERVE,
): SlotLayout {
  positiveInt("window", window);
  positiveInt("reserve", reserve);
  return {
    contextSize: window + reserve,
    slots: 2,
    settings: { kvUnified: true, kvUnifiedPerSlot: window },
    slotIds: { conversation: [0], utility: [1] },
  };
}

/** How dawg lays out the helper model's llama-server: one slot with a cache of its own. */
export interface HelperSlotLayout {
  /** `-c`: the helper's window, which is also all the cache it has. */
  contextSize: number;
  /** `-np`: one slot. Side requests are short and rare; the engine queues the odd overlap. */
  slots: 1;
  settings: { kvUnified: false };
  /** The slot the engine schedules side requests on. */
  slotIds: number[];
}

/**
 * The helper's layout: a single slot of `window` tokens. One slot keeps its cache to one window
 * (768 MiB for MiniCPM5 1B at 32K); a second would double it for an overlap that is rare and
 * costs a short wait in the engine's queue.
 */
export function helperSlotLayout(window: number): HelperSlotLayout {
  positiveInt("window", window);
  return { contextSize: window, slots: 1, settings: { kvUnified: false }, slotIds: [0] };
}

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
