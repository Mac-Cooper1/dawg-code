/**
 * Errors the runtime throws to its callers. The codes are named after the protocol's errors, so a
 * protocol server maps them one to one (`SessionBusy` -> -32002 and so on).
 */
export type RuntimeErrorCode =
  /** No stored session has that id. */
  | "SessionNotFound"
  /** A turn or a compaction is running. */
  | "SessionBusy"
  /** Not allowed now: the session is closed, a mode is refused, a fork point does not exist. */
  | "InvalidState"
  /** A permission, question or plan request is unknown or already answered. */
  | "RequestNotFound"
  /** An argument names something the session does not have (a background task id). */
  | "InvalidParams";

export class RuntimeError extends Error {
  override name = "RuntimeError";
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}
