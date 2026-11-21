/**
 * Typed errors for the runtime. Every error carries a stable `code` so callers (the model
 * manager, the UI) can branch without matching on message text.
 */

export type RuntimeErrorCode =
  | "not-found"
  | "unsupported-arch"
  | "checksum-mismatch"
  | "install-failed"
  | "spawn-failed"
  | "load-timeout"
  | "crash-loop"
  | "port-unavailable"
  | "bad-response"
  | "stopped"
  | "not-ready";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  /** The last lines the runtime wrote, when the error is about a running process. */
  readonly logTail: string;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    options?: { logTail?: string; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RuntimeError";
    this.code = code;
    this.logTail = options?.logTail ?? "";
  }
}

export class ChecksumMismatchError extends RuntimeError {
  readonly expected: string;
  readonly actual: string;
  readonly file: string;

  constructor(file: string, expected: string, actual: string) {
    super("checksum-mismatch", `SHA-256 mismatch for ${file}: expected ${expected}, got ${actual}`);
    this.name = "ChecksumMismatchError";
    this.file = file;
    this.expected = expected;
    this.actual = actual;
  }
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** The process kept exiting and the restart budget is spent. */
export class RuntimeCrashLoopError extends RuntimeError {
  readonly restarts: number;
  readonly lastExit: ExitInfo;

  constructor(restarts: number, lastExit: ExitInfo, logTail: string) {
    super(
      "crash-loop",
      `llama-server exited unexpectedly (${describeExit(lastExit)}) after ${restarts} restart${restarts === 1 ? "" : "s"}`,
      { logTail },
    );
    this.name = "RuntimeCrashLoopError";
    this.restarts = restarts;
    this.lastExit = lastExit;
  }
}

export function describeExit(exit: ExitInfo): string {
  if (exit.signal) return `signal ${exit.signal}`;
  return `exit code ${exit.code ?? "unknown"}`;
}
