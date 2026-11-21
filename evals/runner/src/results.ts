import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { slugify } from "./adapters/launch.ts";

export const RESULT_SCHEMA_VERSION = 1;

const metricsSchema = z.object({
  requests: z.number(),
  prefix_tokens: z.number().nullable(),
  prompt_tokens: z.number().nullable(),
  completion_tokens: z.number().nullable(),
  tool_calls: z.number(),
  malformed_tool_calls: z.number(),
  cache_reuse_ratio: z.number().nullable(),
  failed_edits: z.number().nullable(),
  invalid_records: z.number(),
});

export const resultRowSchema = z.looseObject({
  schema: z.literal(RESULT_SCHEMA_VERSION),
  run_id: z.string(),
  started_at: z.string(),
  agent: z.string(),
  model: z.string(),
  /** Upstream endpoint origin + path, credentials and query stripped. Null without a proxy. */
  endpoint: z.string().nullable(),
  /** Free-form note, e.g. provider and precision. */
  label: z.string().nullable(),
  task: z.string(),
  trial: z.number(),
  /** pass / fail from check.sh; skipped = unmet `requires`; error = the runner could not run it. */
  status: z.enum(["pass", "fail", "skipped", "error"]),
  reason: z.string().nullable(),
  check_exit_code: z.number().nullable(),
  check_timed_out: z.boolean(),
  agent_exit_code: z.number().nullable(),
  agent_timed_out: z.boolean(),
  /** Agent wall time in ms. */
  wall_ms: z.number().nullable(),
  metrics: metricsSchema,
  /** Per-run artefacts, relative to the repo root when inside it. */
  artifacts_dir: z.string().nullable(),
  /** Kept workspace (only with --keep, on failure). */
  workspace: z.string().nullable(),
});
export type ResultRow = z.infer<typeof resultRowSchema>;

/** `<YYYY-MM-DD>-<agent>-<model-slug>.jsonl`, date in UTC. */
export function resultFileName(date: Date, agent: string, model: string): string {
  const day = date.toISOString().slice(0, 10);
  return `${day}-${slugify(agent)}-${slugify(model)}.jsonl`;
}

export function appendResult(resultsDir: string, fileName: string, row: ResultRow): string {
  mkdirSync(resultsDir, { recursive: true });
  const path = join(resultsDir, fileName);
  appendFileSync(path, `${JSON.stringify(row)}\n`);
  return path;
}

export interface ReadResults {
  rows: ResultRow[];
  errors: string[];
}

export function readResultFiles(paths: readonly string[]): ReadResults {
  const rows: ResultRow[] = [];
  const errors: string[] = [];
  for (const p of paths) {
    const lines = readFileSync(p, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.trim() === "") return;
      try {
        const r = resultRowSchema.safeParse(JSON.parse(line));
        if (r.success) rows.push(r.data);
        else errors.push(`${p}:${i + 1}: ${r.error.issues[0]?.message ?? "invalid row"}`);
      } catch (err) {
        errors.push(`${p}:${i + 1}: ${(err as Error).message}`);
      }
    });
  }
  return { rows, errors };
}

/** Strips credentials, query and fragment from an endpoint URL before it is written anywhere. */
export function sanitizeEndpoint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "<invalid url>";
  }
}
