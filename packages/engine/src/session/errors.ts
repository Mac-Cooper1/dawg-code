export type SessionErrorCode =
  /** No session file with that id in that project. */
  | "not-found"
  /** Another writer holds the session. */
  | "locked"
  /** A complete line that does not parse, does not validate, or breaks the sequence. */
  | "corrupt"
  /** The file holds no complete record. */
  | "empty"
  /** Written by a newer version of the format. */
  | "unsupported-version"
  /** The caller passed something the store cannot accept. */
  | "invalid-argument"
  /** The writer was closed, or an earlier write failed and it stopped accepting more. */
  | "closed";

export interface SessionErrorDetails {
  file?: string;
  /** 1-based line number in the session file. */
  line?: number;
  /** For "locked": who holds the lock. */
  holder?: LockHolder;
  lockFile?: string;
  cause?: unknown;
}

export interface LockHolder {
  pid: number;
  hostname: string;
  /** ISO time the lock was taken. */
  since: string;
}

export class SessionStoreError extends Error {
  readonly code: SessionErrorCode;
  readonly file: string | null;
  readonly line: number | null;
  readonly holder: LockHolder | null;
  readonly lockFile: string | null;

  constructor(code: SessionErrorCode, message: string, details: SessionErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "SessionStoreError";
    this.code = code;
    this.file = details.file ?? null;
    this.line = details.line ?? null;
    this.holder = details.holder ?? null;
    this.lockFile = details.lockFile ?? null;
  }
}
