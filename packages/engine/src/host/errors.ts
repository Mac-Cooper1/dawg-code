/**
 * Turning anything a handler throws into a protocol error a client may see. Runtime errors keep
 * their code; everything else is described in words a person can read. Nothing internal leaves:
 * only the first line of a message is kept, and absolute paths outside the directories the client
 * already knows (its sessions' working directories) are replaced.
 */
import path from "node:path";
import { ErrorCodes, RpcError } from "@dawg/protocol";
import { ZodError } from "zod";
import { CommandError } from "../commands/types.ts";
import { ModelError } from "../contracts/model.ts";
import { errorInfoFrom } from "../loop/errors.ts";
import { RuntimeError } from "../runtime/errors.ts";
import { SessionStoreError } from "../session/errors.ts";

const RUNTIME_CODES: Record<RuntimeError["code"], number> = {
  SessionNotFound: ErrorCodes.SessionNotFound,
  SessionBusy: ErrorCodes.SessionBusy,
  InvalidState: ErrorCodes.InvalidState,
  RequestNotFound: ErrorCodes.RequestNotFound,
  InvalidParams: ErrorCodes.InvalidParams,
};

/**
 * An absolute POSIX path of at least two segments. One segment is left alone: it is far more
 * often a slash command ("/help") than a path, and reveals nothing.
 */
const ABSOLUTE_PATH = /(?<![A-Za-z0-9_.~\-/])\/[^\s"'`<>|;,()[\]{}/]+\/[^\s"'`<>|;,()[\]{}]*/g;

function within(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Replaces absolute paths outside `allowed` with "[path]". */
export function redactPaths(text: string, allowed: readonly string[]): string {
  return text.replace(ABSOLUTE_PATH, (match) => {
    // A full stop or colon right after a path ends the sentence, not the path.
    const trailing = /[.:!?]+$/.exec(match)?.[0] ?? "";
    const file = match.slice(0, match.length - trailing.length);
    return allowed.some((root) => within(file, root)) ? match : `[path]${trailing}`;
  });
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.trim() === "" ? "Unknown error." : line.trim();
}

export interface ErrorContext {
  method: string;
  /** Directories the client already knows; paths inside them may appear in messages. */
  allowedRoots: readonly string[];
  /** Told about failures that were not the client's doing, with the full detail. */
  report?: (message: string, detail: unknown) => void;
}

export function toRpcError(error: unknown, context: ErrorContext): RpcError {
  const clean = (message: string) => redactPaths(firstLine(message), context.allowedRoots);
  if (error instanceof RpcError) {
    return new RpcError(error.code, clean(error.message), error.data);
  }
  if (error instanceof RuntimeError) {
    return new RpcError(RUNTIME_CODES[error.code], clean(error.message));
  }
  if (error instanceof CommandError) {
    return new RpcError(
      ErrorCodes.InvalidParams,
      redactPaths(error.message, context.allowedRoots),
      {
        command: error.command,
      },
    );
  }
  if (error instanceof ZodError) {
    return new RpcError(ErrorCodes.InvalidParams, `Invalid params: ${clean(error.message)}`, {
      issues: error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    });
  }
  if (error instanceof SessionStoreError) {
    if (error.code === "not-found") {
      return new RpcError(ErrorCodes.SessionNotFound, "No session with that id.");
    }
    if (error.code === "locked") {
      return new RpcError(
        ErrorCodes.InvalidState,
        "The session is open in another process; close it there first.",
      );
    }
    context.report?.(`${context.method}: session store failure`, error);
    const info = errorInfoFrom(error);
    return new RpcError(ErrorCodes.InternalError, info.message, { kind: info.kind });
  }
  if (error instanceof ModelError) {
    context.report?.(`${context.method}: model failure`, error);
    const info = errorInfoFrom(error);
    return new RpcError(ErrorCodes.InternalError, info.message, {
      kind: info.kind,
      retryable: info.retryable,
    });
  }
  context.report?.(`${context.method}: unexpected failure`, error);
  return new RpcError(
    ErrorCodes.InternalError,
    `The engine could not complete ${context.method}.`,
    { kind: "internal" },
  );
}
