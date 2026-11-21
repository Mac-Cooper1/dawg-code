/** Opening the session a run works in: new, `--continue` or `--resume`. */
import {
  type Client,
  ErrorCodes,
  type MethodParams,
  RpcError,
  type SessionSnapshot,
} from "@dawg/protocol";
import type { CliOptions } from "./args.ts";
import { EXIT } from "./exit-codes.ts";

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
  if (resumed) {
    const id = snapshot.session.id;
    if (options.model !== null && options.model !== snapshot.session.model) {
      await client.request("session.setModel", { sessionId: id, model: options.model });
    }
    if (options.permissionMode !== null && options.permissionMode !== snapshot.session.mode) {
      await client.request("session.setMode", { sessionId: id, mode: options.permissionMode });
    }
  }
  return snapshot;
}
