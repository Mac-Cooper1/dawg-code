import { basename } from "node:path";
import type { ResultRow } from "./results.ts";

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

const DASH = "-";

function fmtInt(n: number | null): string {
  return n === null ? DASH : String(Math.round(n));
}
function fmtSeconds(ms: number | null): string {
  return ms === null ? DASH : (ms / 1000).toFixed(1);
}
function fmtRatio(r: number | null): string {
  return r === null ? DASH : r.toFixed(2);
}
function fmtRate(passed: number, total: number): string {
  return total === 0 ? DASH : `${Math.round((passed / total) * 100)}%`;
}

function nums(rows: readonly ResultRow[], pick: (r: ResultRow) => number | null): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const v = pick(r);
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

interface Stats {
  passed: number;
  total: number;
  errors: number;
  wall: number | null;
  requests: number | null;
  prefix: number | null;
  prompt: number | null;
  completion: number | null;
  malformed: number;
  cache: number | null;
}

/**
 * Pass rate counts errors as failures. Cost figures come only from runs that completed (pass or
 * fail): an errored run's zero requests and near-zero wall time would drag the medians down.
 */
function stats(rows: readonly ResultRow[]): Stats {
  const done = rows.filter((r) => r.status === "pass" || r.status === "fail");
  return {
    passed: rows.filter((r) => r.status === "pass").length,
    total: rows.length,
    errors: rows.filter((r) => r.status === "error").length,
    wall: median(nums(done, (r) => r.wall_ms)),
    requests: median(nums(done, (r) => r.metrics.requests)),
    prefix: median(nums(done, (r) => r.metrics.prefix_tokens)),
    prompt: median(nums(done, (r) => r.metrics.prompt_tokens)),
    completion: median(nums(done, (r) => r.metrics.completion_tokens)),
    malformed: done.reduce((a, r) => a + r.metrics.malformed_tool_calls, 0),
    cache: median(nums(done, (r) => r.metrics.cache_reuse_ratio)),
  };
}

function statCells(s: Stats): string[] {
  return [
    `${s.passed}/${s.total}`,
    fmtRate(s.passed, s.total),
    fmtSeconds(s.wall),
    fmtInt(s.requests),
    fmtInt(s.prefix),
    fmtInt(s.prompt),
    fmtInt(s.completion),
    String(s.malformed),
    fmtRatio(s.cache),
  ];
}

const row = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface ReportInput {
  rows: readonly ResultRow[];
  /** Source file paths; only their base names are printed. */
  sources?: readonly string[];
}

/**
 * Aggregates result rows into a Markdown scoreboard: one section per agent and model with the pass
 * rate per task and overall, per-run medians for the cost metrics, and skipped tasks and errors
 * listed. Output depends only on the rows (sorted), never on time or input order.
 */
export function renderReport(input: ReportInput): string {
  const groups = new Map<string, ResultRow[]>();
  for (const r of input.rows) {
    const key = `${r.agent}\u0000${r.model}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const keys = [...groups.keys()].sort(cmp);

  const out: string[] = ["# Eval scoreboard", ""];
  if (input.sources && input.sources.length > 0) {
    const names = [...new Set(input.sources.map((s) => basename(s)))].sort(cmp);
    out.push(`Sources: ${names.map((n) => `\`${n}\``).join(", ")}`, "");
  }
  if (keys.length === 0) {
    out.push("No results.", "");
    return out.join("\n");
  }

  out.push(row(["Agent", "Model", "Passed", "Pass rate", "Tasks", "Skipped", "Errors"]));
  out.push(row(Array(7).fill("---")));
  for (const key of keys) {
    const rows = groups.get(key) as ResultRow[];
    const ran = rows.filter((r) => r.status !== "skipped");
    const s = stats(ran);
    const taskCount = new Set(ran.map((r) => r.task)).size;
    const skipped = new Set(rows.filter((r) => r.status === "skipped").map((r) => r.task)).size;
    const [agent, model] = key.split("\u0000") as [string, string];
    out.push(
      row([
        agent,
        model,
        `${s.passed}/${s.total}`,
        fmtRate(s.passed, s.total),
        String(taskCount),
        String(skipped),
        String(s.errors),
      ]),
    );
  }
  out.push("");

  const header = [
    "Task",
    "Passed",
    "Pass rate",
    "Wall (s)",
    "Requests",
    "Prefix tokens",
    "Prompt tokens",
    "Completion tokens",
    "Malformed tool calls (total)",
    "Cache reuse",
  ];

  for (const key of keys) {
    const rows = groups.get(key) as ResultRow[];
    const [agent, model] = key.split("\u0000") as [string, string];
    out.push(`## ${agent} / ${model}`, "");

    const meta = (vals: (string | null)[]) =>
      [...new Set(vals.filter((v): v is string => v !== null))].sort(cmp);
    const endpoints = meta(rows.map((r) => r.endpoint));
    const labels = meta(rows.map((r) => r.label));
    if (endpoints.length > 0) out.push(`Endpoint: ${endpoints.map((e) => `\`${e}\``).join(", ")}`);
    if (labels.length > 0) out.push(`Label: ${labels.join(", ")}`);
    if (endpoints.length > 0 || labels.length > 0) out.push("");

    const ran = rows.filter((r) => r.status !== "skipped");
    if (ran.length > 0) {
      out.push("Cost columns are medians per run.", "");
      out.push(row(header));
      out.push(row(Array(header.length).fill("---")));
      const byTask = new Map<string, ResultRow[]>();
      for (const r of ran) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r]);
      for (const task of [...byTask.keys()].sort(cmp)) {
        out.push(row([`\`${task}\``, ...statCells(stats(byTask.get(task) as ResultRow[]))]));
      }
      out.push(row(["**Overall**", ...statCells(stats(ran))]));
      out.push("");
    }

    const skipped = new Map<string, string>();
    for (const r of rows) {
      if (r.status === "skipped") skipped.set(r.task, r.reason ?? "skipped");
    }
    if (skipped.size > 0) {
      out.push("Skipped:", "");
      for (const task of [...skipped.keys()].sort(cmp)) {
        out.push(`- \`${task}\`: ${skipped.get(task)}`);
      }
      out.push("");
    }

    const errors = ran
      .filter((r) => r.status === "error")
      .sort((a, b) => cmp(a.task, b.task) || a.trial - b.trial || cmp(a.run_id, b.run_id));
    if (errors.length > 0) {
      out.push("Errors (counted as failures):", "");
      for (const r of errors) {
        out.push(`- \`${r.task}\` trial ${r.trial}: ${r.reason ?? "unknown error"}`);
      }
      out.push("");
    }
  }
  return out.join("\n");
}
