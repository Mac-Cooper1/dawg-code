/**
 * Plays a list of steps with delays, on the engine's clock. Steps with no delay after the first
 * run in the same timer callback, so at speed Infinity a whole recording plays in one callback:
 * at once, but never inside the request handler that started it.
 */
import type { MockClock } from "./api.ts";

export interface Step {
  /** Wait before this step, in ms of the clock. */
  delay: number;
  run(): void;
}

/** Recorded gaps longer than this play as this long, so a pause in a recording never stalls. */
export const MAX_GAP_MS = 3_000;

/** The delay for a recorded gap at a playback speed. */
export function scaledDelay(gapMs: number, speed: number): number {
  if (!Number.isFinite(speed)) return 0;
  return Math.min(Math.max(0, gapMs), MAX_GAP_MS) / speed;
}

export class Player {
  readonly #clock: MockClock;
  readonly #steps: Step[];
  readonly #onDone: () => void;
  #index = 0;
  #timer: unknown = null;
  #state: "idle" | "playing" | "done" | "stopped" = "idle";

  constructor(clock: MockClock, steps: Step[], onDone: () => void) {
    this.#clock = clock;
    this.#steps = steps;
    this.#onDone = onDone;
  }

  /** True until every step ran or `stop()` was called. */
  get active(): boolean {
    return this.#state === "idle" || this.#state === "playing";
  }

  start(): void {
    if (this.#state !== "idle") return;
    this.#state = "playing";
    this.#schedule();
  }

  /** Cancels the remaining steps. `onDone` is not called. */
  stop(): void {
    if (!this.active) return;
    this.#state = "stopped";
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(): void {
    const step = this.#steps[this.#index];
    if (step === undefined) {
      this.#state = "done";
      this.#onDone();
      return;
    }
    this.#timer = this.#clock.setTimeout(() => this.#tick(), step.delay);
  }

  #tick(): void {
    this.#timer = null;
    do {
      const step = this.#steps[this.#index];
      if (step === undefined) break;
      this.#index += 1;
      step.run();
      if (this.#state !== "playing") return;
    } while ((this.#steps[this.#index]?.delay ?? 1) <= 0);
    this.#schedule();
  }
}
