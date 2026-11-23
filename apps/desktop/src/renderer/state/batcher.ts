/**
 * Collects reducer inputs and hands them over once per animation frame. The spec's budget is one
 * render per frame while text streams; a model can emit hundreds of deltas a second.
 */

/** Schedules `callback` once; the returned function cancels it. */
export type FrameScheduler = (callback: () => void) => () => void;

/**
 * The next animation frame, or a 16 ms timer where there are no frames (Node, tests). A
 * backstop timer also runs in the renderer: a hidden window gets no frames, and events (a card
 * that needs the person, a finished turn) must still land.
 */
export const scheduleFrame: FrameScheduler = (callback) => {
  let done = false;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    done = true;
    if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
  };
  const run = () => {
    if (done) return;
    cancel();
    callback();
  };
  if (raf) frame = raf(run);
  timer = setTimeout(run, raf ? 250 : 16);
  return cancel;
};

export interface Batcher<T> {
  push(item: T): void;
  /** Hands over everything collected now, synchronously. */
  flush(): void;
  /** Drops anything collected and any scheduled hand-over. */
  clear(): void;
  readonly size: number;
}

export function createBatcher<T>(
  deliver: (items: T[]) => void,
  schedule: FrameScheduler = scheduleFrame,
): Batcher<T> {
  let items: T[] = [];
  let cancel: (() => void) | null = null;

  function flush(): void {
    if (cancel) {
      cancel();
      cancel = null;
    }
    if (items.length === 0) return;
    const batch = items;
    items = [];
    deliver(batch);
  }

  return {
    push(item) {
      items.push(item);
      if (!cancel) cancel = schedule(flush);
    },
    flush,
    clear() {
      items = [];
      if (cancel) {
        cancel();
        cancel = null;
      }
    },
    get size() {
      return items.length;
    },
  };
}
