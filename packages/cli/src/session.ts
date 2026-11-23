/** Opening the session a run works in: new, `--continue` or `--resume`. */

import {
  CORE_TOOLS,
  createPromptAssembler,
  createTokenEstimator,
  INTERACTIVE_TOOLS,
} from "@dawg/engine";
import {
  type Client,
  ErrorCodes,
  type MethodParams,
  RpcError,
  type SessionSnapshot,
} from "@dawg/protocol";
import type { CliOptions } from "./args.ts";
import { EXIT } from "./exit-codes.ts";

/**
 * Below this, the context window leaves little room to work once dawg's instructions and tool
 * definitions are in it: one large file read can fill what is left.
 */
export const RECOMMENDED_CONTEXT_WINDOW = 32_768;

let prefixEstimate: number | null = null;

/** Tokens the instructions and tool definitions take, before any project instruction files. */
export function estimatedPrefixTokens(): number {
  if (prefixEstimate === null) {
    const prefix = createPromptAssembler().prefix({
      tools: [...CORE_TOOLS, ...INTERACTIVE_TOOLS],
      instructions: "",
    });
    prefixEstimate = createTokenEstimator().estimate({
      messages: [prefix.system],
      tools: prefix.tools,
    });
  }
  return prefixEstimate;
}

/** The warning for a context window too small to work in comfortably, or null when it is fine. */
export function contextWindowWarning(contextWindow: number): string | null {
  if (contextWindow <= 0 || contextWindow >= RECOMMENDED_CONTEXT_WINDOW) return null;
  const prefix = Math.round(estimatedPrefixTokens() / 500) * 500;
  const n = (value: number) => value.toLocaleString("en-US");
  return (
    `Warning: the model's context window is ${n(contextWindow)} tokens, and dawg's instructions ` +
    `and tool definitions take about ${n(prefix)} of them, which leaves little room to work. ` +
    `Load the model with a context of ${n(RECOMMENDED_CONTEXT_WINDOW)} tokens or more.`
  );
}

/** A failure the run reports and exits on. */
export class RunError extends Error {
  override name = "RunError";
  readonly exitCode: number;

  constructor(exitCode: number, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Errors that are the person's doing (a wrong id, a refused mode) exit as bad usage. */
export function runErrorFrom(error: unknown): RunError {
  if (error instanceof RunError) return error;
  if (error instanceof RpcError) {
    const usage = [
      ErrorCodes.SessionNotFound,
      ErrorCodes.InvalidState,
      ErrorCodes.InvalidParams,
    ].includes(error.code as never);
    return new RunError(usage ? EXIT.usage : EXIT.error, error.message);
  }
  return new RunError(EXIT.error, error instanceof Error ? error.message : String(error));
}

export async function openSession(
  client: Client,
  options: CliOptions,
  cwd: string,
  log: (line: string) => void,
): Promise<SessionSnapshot> {
  const create = () => {
    const params: MethodParams<"session.create"> = { cwd };
    if (options.permissionMode !== null) params.mode = options.permissionMode;
    if (options.model !== null) params.model = options.model;
    return client.request("session.create", params);
  };
  let snapshot: SessionSnapshot;
  let resumed = false;
  if (options.resume !== null) {
    snapshot = await client.request("session.resume", { sessionId: options.resume });
    resumed = true;
  } else if (options.continue) {
    const { sessions } = await client.request("session.list", { projectDir: cwd, limit: 1 });
    const latest = sessions[0];
    if (latest === undefined) {
      log(`No earlier session in ${cwd}; starting a new one.`);
      snapshot = await create();
    } else {
      snapshot = await client.request("session.resume", { sessionId: latest.id });
      resumed = true;
    }
  } else {
    snapshot = await create();
  }
  const id = snapshot.session.id;
  if (resumed) {
    if (options.model !== null && options.model !== snapshot.session.model) {
      await client.request("session.setModel", { sessionId: id, model: options.model });
    }
    if (options.permissionMode !== null && options.permissionMode !== snapshot.session.mode) {
      await client.request("session.setMode", { sessionId: id, mode: options.permissionMode });
    }
  }
  // After any model change, since a new model can offer different levels. Set through the
  // session rather than at creation, so a level the model lacks is refused with the levels it
  // does offer instead of being dropped.
  if (options.effort !== null && options.effort !== snapshot.session.effort) {
    const { effort } = await client.request("session.setEffort", {
      sessionId: id,
      effort: options.effort,
    });
    snapshot = { ...snapshot, session: { ...snapshot.session, effort } };
  }
  const warning = contextWindowWarning(snapshot.modelInfo?.contextWindow ?? 0);
  if (warning !== null) log(warning);
  return snapshot;
}
