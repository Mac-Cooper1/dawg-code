import { ErrorCodes } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import { ModelError } from "../contracts/model.ts";
import { toRpcError } from "../host/errors.ts";
import { errorInfoFrom } from "./errors.ts";

describe("errorInfoFrom", () => {
  it("keeps the message of an 'unavailable' model error, and whether to retry", () => {
    const message = "No model is installed yet. Download one in Settings → Models.";
    expect(errorInfoFrom(new ModelError("unavailable", message))).toEqual({
      kind: "model_unavailable",
      message,
      detail: null,
      retryable: false,
    });
    expect(
      errorInfoFrom(
        new ModelError("unavailable", "The runtime is restarting.", { retryable: true }),
      ),
    ).toEqual({
      kind: "model_unavailable",
      message: "The runtime is restarting.",
      detail: null,
      retryable: true,
    });
  });

  it("still describes other model errors in its own words, with the message as the detail", () => {
    expect(
      errorInfoFrom(new ModelError("connection", "cannot reach http://127.0.0.1:1/v1")),
    ).toEqual({
      kind: "model_unavailable",
      message: "The model server could not be reached.",
      detail: "cannot reach http://127.0.0.1:1/v1",
      retryable: true,
    });
  });

  it("reaches a protocol client unchanged", () => {
    const error = toRpcError(new ModelError("unavailable", "No model is installed yet."), {
      method: "session.prompt",
      allowedRoots: [],
    });
    expect(error.code).toBe(ErrorCodes.InternalError);
    expect(error.message).toBe("No model is installed yet.");
    expect(error.data).toEqual({ kind: "model_unavailable", retryable: false });
  });
});
