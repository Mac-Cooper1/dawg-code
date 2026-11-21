import { expect, test } from "vitest";
import { packageName } from "./index.ts";

test("package is wired up", () => {
  expect(packageName).toBe("@dawg/eval-runner");
});
