/**
 * Notices a model stuck making the same call and getting the same result. Calls are seen in the
 * order they were made, across replies; any different call or result starts the count again.
 */
import type { ToolCall, ToolResultMessage } from "../contracts/messages.ts";

export class RepeatDetector {
  #key: string | null = null;
  #count = 0;

  /** Records one call and its result; returns how many times running it has now been seen. */
  observe(call: ToolCall, result: ToolResultMessage): number {
    const key = JSON.stringify([call.name, call.rawArguments ?? call.arguments, result.content]);
    if (key === this.#key) {
      this.#count += 1;
    } else {
      this.#key = key;
      this.#count = 1;
    }
    return this.#count;
  }

  reset(): void {
    this.#key = null;
    this.#count = 0;
  }
}
