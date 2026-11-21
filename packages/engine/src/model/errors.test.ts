import { expect, test } from "vitest";
import { httpError } from "./errors.ts";

test("a context overflow carries the sizes the server reported", () => {
  const body = JSON.stringify({
    error: {
      code: 400,
      message: "request (9000 tokens) exceeds the available context size (8192 tokens)",
      type: "exceed_context_size_error",
      n_prompt_tokens: 9000,
      n_ctx: 8192,
    },
  });
  const error = httpError(400, "Bad Request", body);
  expect(error.kind).toBe("context_overflow");
  expect(error.promptTokens).toBe(9000);
  expect(error.contextWindow).toBe(8192);
});

test("an overflow recognised only by its wording carries no sizes", () => {
  const error = httpError(
    400,
    "Bad Request",
    '{"error":{"message":"maximum context length exceeded"}}',
  );
  expect(error.promptTokens).toBeNull();
  expect(error.contextWindow).toBeNull();
});
