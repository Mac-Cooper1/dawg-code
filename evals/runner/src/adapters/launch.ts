import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { baseEnv, runProcess } from "../proc.ts";
import type { AgentRunResult, Endpoint, LaunchSpec, RunContext } from "./types.ts";

export function requireEndpoint(ctx: RunContext, adapterId: string): Endpoint {
  if (!ctx.endpoint) throw new Error(`adapter "${adapterId}" needs a model endpoint`);
  return ctx.endpoint;
}

/** The full environment an adapter's process gets: minimal base env plus the spec's additions. */
export function launchEnv(ctx: RunContext, spec: LaunchSpec): Record<string, string> {
  return { ...baseEnv(ctx.homeDir, ctx.tmpDir), ...spec.env };
}

/** Writes the spec's config files, then runs its command in the workspace with the run's timeout. */
export async function executeLaunch(ctx: RunContext, spec: LaunchSpec): Promise<AgentRunResult> {
  for (const [path, content] of Object.entries(spec.files)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const stdoutPath = join(ctx.artifactsDir, "agent.stdout.log");
  const stderrPath = join(ctx.artifactsDir, "agent.stderr.log");
  const res = await runProcess({
    command: spec.command,
    args: spec.args,
    cwd: ctx.workspace,
    env: launchEnv(ctx, spec),
    stdoutPath,
    stderrPath,
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  });
  return {
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    stdoutPath,
    stderrPath,
    transcriptPath: spec.transcriptPath,
    error: res.spawnError ?? undefined,
  };
}

/** A filesystem- and identifier-safe form of a model name. */
export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "none";
}
