import type { CatalogEntry } from "../types.ts";

/**
 * The memory rule from PLAN.md section 6: weights + cache at the target context + 2 GB
 * must fit within about 70% of unified memory.
 */
export const MEMORY_BUDGET_FRACTION = 0.7;
/** The "+ 2 GB" of the rule, taken as 2 GiB: runtime, compute buffers and small fixed state. */
export const RUNTIME_OVERHEAD_BYTES = 2 * 1024 ** 3;

export interface MemoryNeed {
  /** Everything loaded as weights: the model file plus the projector, if any. */
  weightsBytes: number;
  /** Cache bytes that grow with each token of context. */
  cacheBytesPerToken: number;
  contextTokens: number;
}

/** Bytes the rule needs to be in use: weights + cache + overhead. */
export function workingSetBytes(need: MemoryNeed): number {
  return need.weightsBytes + need.cacheBytesPerToken * need.contextTokens + RUNTIME_OVERHEAD_BYTES;
}

/** The smallest unified memory size for which `need` satisfies the rule. */
export function requiredMemoryBytes(need: MemoryNeed): number {
  return Math.ceil(workingSetBytes(need) / MEMORY_BUDGET_FRACTION);
}

export function fitsMemoryRule(need: MemoryNeed, memoryBytes: number): boolean {
  return workingSetBytes(need) <= memoryBytes * MEMORY_BUDGET_FRACTION;
}

/**
 * The largest context (in tokens) the rule allows on a machine, or 0 when the weights do not fit.
 * `reservedBytes` is memory something else running beside the model (the helper model) takes out
 * of the same 70% budget.
 */
export function maxContextForMemory(
  weightsBytes: number,
  cacheBytesPerToken: number,
  memoryBytes: number,
  reservedBytes = 0,
): number {
  const room =
    memoryBytes * MEMORY_BUDGET_FRACTION - weightsBytes - RUNTIME_OVERHEAD_BYTES - reservedBytes;
  if (room <= 0) return 0;
  return Math.floor(room / cacheBytesPerToken);
}

/**
 * Estimated cache bytes per context token, by source repo (the architecture is the same for
 * every quantization in a repo).
 *
 * Method: llama.cpp's default cache type is f16 (2 bytes). Each layer that keeps keys and
 * values for the whole context costs `2 (K and V) × kv_heads × head_dim × 2 bytes` per token.
 * Sliding-window layers keep only their window and linear-attention layers keep a fixed-size
 * state; both are a few tens of MiB whatever the context, so they fall under the 2 GiB
 * overhead rather than here. Figures come from each model's config.json on Hugging Face,
 * read on 2026-11-20. A quantized cache (q8_0) would halve them; these assume none.
 */
export const CACHE_BYTES_PER_TOKEN: Readonly<Record<string, number>> = {
  // gpt-oss-20b: 24 layers alternating sliding (window 128) and full attention;
  // 12 full × 8 KV heads × 64 dim × 2 × 2 B = 24,576 B.
  "unsloth/gpt-oss-20b-GGUF": 12 * 8 * 64 * 2 * 2,
  // Qwen3.8-27B: 64 layers, one in four full attention (the rest Gated DeltaNet);
  // 16 full × 4 KV heads × 256 dim × 2 × 2 B = 65,536 B.
  "unsloth/Qwen3.8-27B-GGUF": 16 * 4 * 256 * 2 * 2,
  // Qwen3.6-35B-A3B: 40 layers, one in four full attention;
  // 10 full × 2 KV heads × 256 dim × 2 × 2 B = 20,480 B.
  "unsloth/Qwen3.6-35B-A3B-GGUF": 10 * 2 * 256 * 2 * 2,
  // Laguna XS 2.1: 40 layers, 10 global and 30 sliding (window 512);
  // 10 global × 8 KV heads × 128 dim × 2 × 2 B = 40,960 B. (The card mentions an FP8
  // cache; this assumes llama.cpp's f16 default, so it is conservative.)
  "poolside/Laguna-XS-2.1-GGUF": 10 * 8 * 128 * 2 * 2,
  // MiniCPM5-1B (the helper): 24 layers, all full attention (plain Llama);
  // 24 × 2 KV heads × 128 dim × 2 × 2 B = 24,576 B. Read from openbmb/MiniCPM5-1B config.json
  // on 2026-11-27.
  "openbmb/MiniCPM5-1B-GGUF": 24 * 2 * 128 * 2 * 2,
};

/**
 * A helper's own overhead beside its weights and cache: its llama-server process and compute
 * buffers. The main rule's 2 GiB is sized for large models; a ~1B model's buffers at a 32K
 * window are a few hundred MiB, so half a GiB is a generous allowance.
 */
export const HELPER_OVERHEAD_BYTES = 512 * 1024 ** 2;

/**
 * Memory a helper uses while it runs: weights, the cache of its slots at `contextTokens` each,
 * and `HELPER_OVERHEAD_BYTES`. Counted against the same budget as the main model, so the main
 * model's window is chosen with the helper's share already taken. An unknown cache size counts
 * as a dense 1B model's (the largest a helper is likely to have), so the estimate stays high.
 */
export function helperWorkingSetBytes(
  entry: CatalogEntry,
  options: { contextTokens?: number; slots?: number } = {},
  cacheTable: Readonly<Record<string, number>> = CACHE_BYTES_PER_TOKEN,
): number {
  const contextTokens = options.contextTokens ?? entry.context.default;
  const perToken = cacheTable[entry.source.repo] ?? UNKNOWN_HELPER_CACHE_BYTES_PER_TOKEN;
  return (
    entryWeightsBytes(entry) +
    perToken * contextTokens * (options.slots ?? 1) +
    HELPER_OVERHEAD_BYTES
  );
}

/** A dense model of about 1.7B parameters: 28 layers × 8 KV heads × 128 dim × 2 × 2 B. */
const UNKNOWN_HELPER_CACHE_BYTES_PER_TOKEN = 28 * 8 * 128 * 2 * 2;

/** Weights loaded for an entry: the model file plus its projector. */
export function entryWeightsBytes(entry: CatalogEntry): number {
  return entry.source.sizeBytes + (entry.projector?.sizeBytes ?? 0);
}

/** The memory need of an entry at a context (its default context when omitted), if its cache size is known. */
export function entryMemoryNeed(
  entry: CatalogEntry,
  contextTokens: number = entry.context.default,
  cacheTable: Readonly<Record<string, number>> = CACHE_BYTES_PER_TOKEN,
): MemoryNeed | undefined {
  const cacheBytesPerToken = cacheTable[entry.source.repo];
  if (cacheBytesPerToken === undefined) return undefined;
  return { weightsBytes: entryWeightsBytes(entry), cacheBytesPerToken, contextTokens };
}
