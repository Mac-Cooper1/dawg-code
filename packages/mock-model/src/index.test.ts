import { expect, test } from "vitest";
import * as api from "./index.ts";

test("the public API is exported", () => {
  expect(api.packageName).toBe("@dawg/mock-model");
  for (const name of [
    "startMockModel",
    "parseScript",
    "text",
    "reasoning",
    "toolCall",
    "toolCalls",
    "malformedToolCall",
    "empty",
    "dropped",
    "stalled",
    "httpError",
    "contextOverflow",
    "nonStreaming",
    "streamError",
    "invalidResponse",
  ]) {
    expect(typeof (api as Record<string, unknown>)[name]).toBe("function");
  }
});
