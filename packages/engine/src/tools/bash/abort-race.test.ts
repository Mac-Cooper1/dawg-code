import { afterEach, expect, test } from "vitest";
import { createTestToolContext, type TestToolContext } from "../../testing/context.ts";
import { bashTool } from "./bash.ts";

const contexts: TestToolContext[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((c) => c.cleanup()));
});

// The tool checks for an interrupt, then does asynchronous set-up, then starts listening for
// one. An interrupt landing in between must still stop the command.
test.each([0, 1, 2, 5, 10, 20])(
  "an interrupt %i ms after the call starts stops the command",
  async (delayMs) => {
    const test = await createTestToolContext();
    contexts.push(test);
    const started = Date.now();
    const running = bashTool.execute({ command: "sleep 30" }, test.ctx).then(
      (output) => ({
        interrupted: output.display?.kind === "command" && output.display.interrupted,
      }),
      () => ({ interrupted: true }),
    );
    if (delayMs === 0) queueMicrotask(() => test.abort());
    else setTimeout(() => test.abort(), delayMs);

    const result = await running;
    expect(result.interrupted).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  },
);
