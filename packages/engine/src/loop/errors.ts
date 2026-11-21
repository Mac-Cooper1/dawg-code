/** Turning failures into the protocol's user-presentable `ErrorInfo`. */
import type { ErrorInfo, ErrorKind } from "@dawg/protocol";
import { ModelError } from "../contracts/model.ts";
import { SessionStoreError } from "../session/errors.ts";

export function errorInfo(
  kind: ErrorKind,
  message: string,
  detail: string | null = null,
  retryable = false,
): ErrorInfo {
  return { kind, message, detail, retryable };
}

/** A person-readable description of any failure the loop or the session can meet. */
export function errorInfoFrom(error: unknown): ErrorInfo {
  if (error instanceof ModelError) {
    const detail = error.message;
    switch (error.kind) {
      case "connection":
        return errorInfo(
          "model_unavailable",
          "The model server could not be reached.",
          detail,
          true,
        );
      case "timeout":
        return errorInfo("model_unavailable", "The model stopped responding.", detail, true);
      case "stream_interrupted":
        return errorInfo("model_unavailable", "The model's reply broke off.", detail, true);
      case "context_overflow":
        return errorInfo(
          "context_overflow",
          "The conversation no longer fits the model's context window, even after compacting it.",
          detail,
          false,
        );
      case "http":
        return errorInfo(
          "model_error",
          `The model server answered with an error${error.status === null ? "" : ` (HTTP ${error.status})`}.`,
          detail,
          error.retryable,
        );
      case "invalid_response":
        return errorInfo(
          "model_error",
          "The model server sent a reply that could not be read.",
          detail,
          error.retryable,
        );
      case "aborted":
        return errorInfo("other", "The request was stopped.", detail, true);
    }
  }
  if (error instanceof SessionStoreError) {
    return errorInfo(
      "storage",
      "The session transcript could not be written.",
      error.message,
      false,
    );
  }
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return errorInfo("internal", "Something went wrong inside the engine.", detail, false);
}
