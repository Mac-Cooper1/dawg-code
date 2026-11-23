/**
 * The engine's only access to time. `realClock` uses the global timers, which exist in the
 * Electron utility process, browsers and Node alike; `createManualClock` lets tests step through
 * a recording or play it at once.
 */
import type { MockClock } from "./api.ts";

export const realClock: MockClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

export interface ManualClock extends MockClock {
  /** Moves time forward by `ms`, running every timer that falls due on the way, in order. */
  advance(ms: number): void;
  /** Runs timers until none are left (at most `limit` of them), moving time to each. */
  runAll(limit?: number): void;
  /** Timers waiting to run. */
  readonly pending: number;
}

interface Timer {
  id: number;
  due: number;
  callback: () => void;
}

/** A clock that only moves when told to. Timers due at the same time run in creation order. */
export function createManualClock(start = Date.UTC(2026, 10, 22, 12, 0, 0)): ManualClock {
  let now = start;
  let nextId = 1;
  const timers: Timer[] = [];

  function next(until: number): Timer | undefined {
    let best: Timer | undefined;
    for (const timer of timers) {
      if (timer.due > until) continue;
      if (
        best === undefined ||
        timer.due < best.due ||
        (timer.due === best.due && timer.id < best.id)
      ) {
        best = timer;
      }
    }
    return best;
  }

  function run(timer: Timer): void {
    timers.splice(timers.indexOf(timer), 1);
    now = Math.max(now, timer.due);
    timer.callback();
  }

  return {
    now: () => now,
    setTimeout(callback, ms) {
      const timer = { id: nextId++, due: now + Math.max(0, ms), callback };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(handle) {
      const index = timers.findIndex((t) => t.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    advance(ms) {
      const target = now + ms;
      for (let timer = next(target); timer !== undefined; timer = next(target)) run(timer);
      now = target;
    },
    runAll(limit = 1_000_000) {
      for (let i = 0; i < limit; i++) {
        const timer = next(Number.POSITIVE_INFINITY);
        if (timer === undefined) return;
        run(timer);
      }
      throw new Error(`Timers still pending after ${limit} runs`);
    },
    get pending() {
      return timers.length;
    },
  };
}
