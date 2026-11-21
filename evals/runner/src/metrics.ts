import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

// Our own reading of the recording proxy's record format (evals/proxy contract). Tolerant: unknown
// fields are kept, and most fields may be missing or null.
const num = z.number().nullable().optional();

const toolCallSchema = z.looseObject({
  name: z.string().nullable().optional(),
  arguments_valid_json: z.boolean().nullable().optional(),
  schema_valid: z.boolean().nullable().optional(),
  error: z.string().nullable().optional(),
});

export const proxyRecordSchema = z.looseObject({
  seq: z.number(),
  started_at: z.string().optional(),
  duration_ms: num,
  api: z.string().optional(),
  path: z.string().optional(),
  model: z.string().nullable().optional(),
  stream: z.boolean().nullable().optional(),
  status: num,
  request: z.looseObject({ messages: num, tools: num, body_bytes: num }).nullable().optional(),
  usage: z
    .looseObject({ prompt_tokens: num, completion_tokens: num, cached_tokens: num })
    .nullable()
    .optional(),
  timings: z
    .looseObject({
      cache_n: num,
      prompt_n: num,
      prompt_per_second: num,
      predicted_n: num,
      predicted_per_second: num,
    })
    .nullable()
    .optional(),
  tool_calls: z.array(toolCallSchema).nullable().optional(),
  finish_reason: z.string().nullable().optional(),
  error: z.unknown().optional(),
});
export type ProxyRecord = z.infer<typeof proxyRecordSchema>;

export interface ParsedRecords {
  records: ProxyRecord[];
  /** Lines that were not valid JSON or did not match the schema. */
  invalidLines: number;
}

export function parseRecords(text: string): ParsedRecords {
  const records: ProxyRecord[] = [];
  let invalidLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      invalidLines++;
      continue;
    }
    const r = proxyRecordSchema.safeParse(json);
    if (r.success) records.push(r.data);
    else invalidLines++;
  }
  records.sort((a, b) => a.seq - b.seq);
  return { records, invalidLines };
}

export function readRecordFile(path: string): ParsedRecords {
  if (!existsSync(path)) return { records: [], invalidLines: 0 };
  return parseRecords(readFileSync(path, "utf8"));
}

export interface RunMetrics {
  /** Model requests (api other than "other"). */
  requests: number;
  /** Prompt tokens of the first generation request that reported usage. */
  prefix_tokens: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  tool_calls: number;
  /** Tool calls whose arguments were not valid JSON or failed the declared schema. */
  malformed_tool_calls: number;
  /** sum(cache_n) / sum(cache_n + prompt_n) over records with timings; null without timings. */
  cache_reuse_ratio: number | null;
  /** From the agent transcript; not implemented by any adapter yet. */
  failed_edits: number | null;
  /** Proxy record lines the runner could not parse. */
  invalid_records: number;
}

export function emptyMetrics(): RunMetrics {
  return {
    requests: 0,
    prefix_tokens: null,
    prompt_tokens: null,
    completion_tokens: null,
    tool_calls: 0,
    malformed_tool_calls: 0,
    cache_reuse_ratio: null,
    failed_edits: null,
    invalid_records: 0,
  };
}

function sumNullable(values: (number | null | undefined)[]): number | null {
  let seen = false;
  let total = 0;
  for (const v of values) {
    if (typeof v === "number") {
      seen = true;
      total += v;
    }
  }
  return seen ? total : null;
}

export function computeMetrics(parsed: ParsedRecords): RunMetrics {
  const gen = parsed.records.filter((r) => r.api !== "other");
  const first = gen.find((r) => typeof r.usage?.prompt_tokens === "number");
  const calls = gen.flatMap((r) => r.tool_calls ?? []);
  const malformed = calls.filter(
    (c) => c.arguments_valid_json === false || c.schema_valid === false,
  ).length;

  let cacheN = 0;
  let promptN = 0;
  let sawTimings = false;
  for (const r of gen) {
    const t = r.timings;
    if (!t) continue;
    if (typeof t.cache_n !== "number" && typeof t.prompt_n !== "number") continue;
    sawTimings = true;
    cacheN += t.cache_n ?? 0;
    promptN += t.prompt_n ?? 0;
  }
  const denom = cacheN + promptN;

  return {
    requests: gen.length,
    prefix_tokens: first?.usage?.prompt_tokens ?? null,
    prompt_tokens: sumNullable(gen.map((r) => r.usage?.prompt_tokens)),
    completion_tokens: sumNullable(gen.map((r) => r.usage?.completion_tokens)),
    tool_calls: calls.length,
    malformed_tool_calls: malformed,
    cache_reuse_ratio: sawTimings && denom > 0 ? cacheN / denom : null,
    failed_edits: null,
    invalid_records: parsed.invalidLines,
  };
}
