import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "../proc.ts";
import { scriptEnv } from "../workspace.ts";
import type { AgentAdapter, AgentRunResult, RunContext } from "./types.ts";

const ALL = new Set(["*"]);

/**
 * `reference`: applies the task's solution/ overlay, then runs solution.sh. Proves the pipeline
 * end to end without a model.
 */
export function referenceAdapter(): AgentAdapter {
  return {
    id: "reference",
    features: ALL,
    needsEndpoint: false,
    async run(ctx: RunContext): Promise<AgentRunResult> {
      const stdoutPath = join(ctx.artifactsDir, "agent.stdout.log");
      const stderrPath = join(ctx.artifactsDir, "agent.stderr.log");
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      cpSync(ctx.task.solutionDir, ctx.workspace, { recursive: true, force: true });
      if (!ctx.task.solutionScript) return { exitCode: 0, timedOut: false, stdoutPath, stderrPath };
      const env = scriptEnv(ctx.task, {
        dir: ctx.workspace,
        tmpDir: ctx.tmpDir,
        scriptHomeDir: ctx.homeDir,
      });
      const res = await runProcess({
        command: "bash",
        args: [ctx.task.solutionScript],
        cwd: ctx.workspace,
        env,
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
        error: res.spawnError ?? undefined,
      };
    },
  };
}

/** `noop`: does nothing. Every task must fail with it. */
export function noopAdapter(): AgentAdapter {
  return {
    id: "noop",
    features: ALL,
    needsEndpoint: false,
    async run(ctx: RunContext): Promise<AgentRunResult> {
      const stdoutPath = join(ctx.artifactsDir, "agent.stdout.log");
      const stderrPath = join(ctx.artifactsDir, "agent.stderr.log");
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return { exitCode: 0, timedOut: false, stdoutPath, stderrPath };
    },
  };
}
