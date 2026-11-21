import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { requestJson } from "../endpoint/http.ts";
import { RuntimeError } from "./errors.ts";

/**
 * Prompt-cache hooks for the engine (Phase 2): warm a prefix into a slot, and save / restore a
 * slot's KV cache to disk under a key that changes whenever anything that shaped the cache does.
 */

/** How a model file is identified in cache keys. Prefer the content hash when it is known. */
export type ModelIdentity =
  | { sha256: string }
  | { path: string; sizeBytes: number; mtimeMs: number };

export async function modelIdentityFromFile(path: string): Promise<ModelIdentity> {
  const info = await stat(path);
  return { path, sizeBytes: info.size, mtimeMs: Math.trunc(info.mtimeMs) };
}

export interface SlotCacheKeyInput {
  model: ModelIdentity;
  /** The chat template the server reports (`/props` → `chat_template`). */
  chatTemplate: string;
  /** The exact prefix: rendered text, or the serialized request that produced it. */
  prefix: string | Uint8Array;
  /** llama.cpp build (`/props` → `build_info`); a new build never reuses old cache files. */
  runtimeBuild: string;
  /** Anything else that changes the KV contents, such as the KV cache type. */
  extra?: string;
}

/**
 * A SHA-256 over length-prefixed fields, so no two different inputs can produce the same
 * byte stream. Returned as 64 hex characters, which is also a valid slot file name stem.
 */
export function slotCacheKey(input: SlotCacheKeyInput): string {
  const hash = createHash("sha256");
  const field = (value: string | Uint8Array) => {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  };
  field("dawg-slot-cache-v1");
  const m = input.model;
  field("sha256" in m ? `sha256:${m.sha256}` : `file:${m.path}:${m.sizeBytes}:${m.mtimeMs}`);
  field(input.runtimeBuild);
  field(input.chatTemplate);
  field(input.extra ?? "");
  field(input.prefix);
  return hash.digest("hex");
}

export function slotFileName(key: string): string {
  if (!/^[0-9a-f]{64}$/.test(key))
    throw new RuntimeError("bad-response", `invalid slot cache key: ${key}`);
  return `${key}.bin`;
}

/** What the cache hooks need to reach a running server. */
export interface CacheTarget {
  /** Server root, without `/v1`, e.g. http://127.0.0.1:PORT */
  origin: string;
  apiKey: string;
  totalSlots: number;
  slotSaveDir: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type WarmRequest =
  | {
      slot: number;
      /** Chat messages forming the prefix (system prompt, early turns). */
      messages: unknown[];
      /**
       * Extra chat-completion fields that change how the prefix is rendered, e.g. `tools` or
       * `chat_template_kwargs`. They must match what real requests send, or the cache will
       * not line up.
       */
      request?: Record<string, unknown>;
    }
  | {
      slot: number;
      /** An already-rendered prompt for `/completion`. */
      prompt: string;
    };

export interface WarmResult {
  slot: number;
  /** Prompt tokens in the warmed prefix. */
  promptTokens: number;
  /** Of those, how many were already cached before this call. */
  cachedTokens: number;
  promptMs: number;
}

const timingsSchema = z
  .object({
    cache_n: z.number().optional(),
    prompt_n: z.number().optional(),
    prompt_ms: z.number().optional(),
  })
  .loose();

const warmResponseSchema = z
  .object({
    timings: timingsSchema.optional(),
    usage: z.object({ prompt_tokens: z.number() }).loose().optional(),
    tokens_evaluated: z.number().optional(),
  })
  .loose();

function checkSlot(target: CacheTarget, slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= target.totalSlots) {
    throw new RuntimeError(
      "bad-response",
      `slot ${slot} does not exist (server has ${target.totalSlots})`,
    );
  }
}

/**
 * Processes a prefix into `slot` without generating a reply. On b12359 a request for zero
 * tokens still samples one, so this asks for one explicitly; the cached prompt is what counts
 * (`timings.cache_n` on the next request with the same prefix shows the reuse).
 */
export async function warmPrefix(target: CacheTarget, request: WarmRequest): Promise<WarmResult> {
  checkSlot(target, request.slot);
  const common = { cache_prompt: true, id_slot: request.slot, stream: false };
  const result =
    "messages" in request
      ? await requestJson(`${target.origin}/v1/chat/completions`, {
          apiKey: target.apiKey,
          fetchImpl: target.fetchImpl,
          timeoutMs: target.timeoutMs ?? 600_000,
          body: { ...request.request, messages: request.messages, max_tokens: 1, ...common },
        })
      : await requestJson(`${target.origin}/completion`, {
          apiKey: target.apiKey,
          fetchImpl: target.fetchImpl,
          timeoutMs: target.timeoutMs ?? 600_000,
          body: { prompt: request.prompt, n_predict: 1, ...common },
        });
  if (!result.ok) {
    throw new RuntimeError("bad-response", `warm-up failed: ${result.message}`);
  }
  const parsed = warmResponseSchema.parse(result.data);
  const cached = parsed.timings?.cache_n ?? 0;
  const processed = parsed.timings?.prompt_n ?? 0;
  return {
    slot: request.slot,
    promptTokens: parsed.usage?.prompt_tokens ?? parsed.tokens_evaluated ?? cached + processed,
    cachedTokens: cached,
    promptMs: parsed.timings?.prompt_ms ?? 0,
  };
}

export interface SlotSaveResult {
  slot: number;
  key: string;
  file: string;
  tokens: number;
  bytes: number;
}

const saveSchema = z.object({ n_saved: z.number(), n_written: z.number() }).loose();
const restoreSchema = z.object({ n_restored: z.number(), n_read: z.number() }).loose();

export async function saveSlot(
  target: CacheTarget,
  slot: number,
  key: string,
): Promise<SlotSaveResult> {
  checkSlot(target, slot);
  const filename = slotFileName(key);
  const result = await requestJson(`${target.origin}/slots/${slot}?action=save`, {
    apiKey: target.apiKey,
    fetchImpl: target.fetchImpl,
    timeoutMs: target.timeoutMs ?? 120_000,
    body: { filename },
  });
  if (!result.ok)
    throw new RuntimeError("bad-response", `saving slot ${slot} failed: ${result.message}`);
  const parsed = saveSchema.parse(result.data);
  return {
    slot,
    key,
    file: join(target.slotSaveDir, filename),
    tokens: parsed.n_saved,
    bytes: parsed.n_written,
  };
}

export type SlotRestoreResult =
  | { restored: true; slot: number; key: string; tokens: number; bytes: number }
  | {
      restored: false;
      slot: number;
      key: string;
      /** "missing": no file for this key. "rejected": the server would not load it. */
      reason: "missing" | "rejected";
      message?: string;
    };

/**
 * Restores a slot saved under `key`. Because the key covers model, template, build and prefix,
 * a cache made for anything else simply has no file, and the caller warms from scratch.
 */
export async function restoreSlot(
  target: CacheTarget,
  slot: number,
  key: string,
): Promise<SlotRestoreResult> {
  checkSlot(target, slot);
  const filename = slotFileName(key);
  try {
    await stat(join(target.slotSaveDir, filename));
  } catch {
    return { restored: false, slot, key, reason: "missing" };
  }
  const result = await requestJson(`${target.origin}/slots/${slot}?action=restore`, {
    apiKey: target.apiKey,
    fetchImpl: target.fetchImpl,
    timeoutMs: target.timeoutMs ?? 120_000,
    body: { filename },
  });
  if (!result.ok) {
    if (result.status === 400) {
      return { restored: false, slot, key, reason: "rejected", message: result.message };
    }
    throw new RuntimeError("bad-response", `restoring slot ${slot} failed: ${result.message}`);
  }
  const parsed = restoreSchema.parse(result.data);
  return { restored: true, slot, key, tokens: parsed.n_restored, bytes: parsed.n_read };
}

export async function eraseSlot(target: CacheTarget, slot: number): Promise<void> {
  checkSlot(target, slot);
  const result = await requestJson(`${target.origin}/slots/${slot}?action=erase`, {
    apiKey: target.apiKey,
    fetchImpl: target.fetchImpl,
    timeoutMs: target.timeoutMs ?? 30_000,
    body: {},
  });
  if (!result.ok)
    throw new RuntimeError("bad-response", `erasing slot ${slot} failed: ${result.message}`);
}
