/**
 * Sharing a model's slots between the requests of several sessions (docs/specs/
 * phase-3-desktop-app.md: "With one local model they share it; the sidebar shows which are
 * queued") and, later, of several agents in one session (phase-4-compatibility.md, "Scheduling on
 * one model").
 *
 * llama-server keeps one prompt cache per slot. Two requests sent to one slot are served one at a
 * time anyway, and each evicts the other's cache, but the engine would not know who waits. So
 * every conversation request takes a slot here before it is sent and gives it back when its
 * stream ends, however it ends (finished, failed or aborted).
 *
 * - First come, first served. A request waits only when every slot is taken; the one that has
 *   waited longest gets the next slot that frees.
 * - An owner (a session; later an agent within one) gets the slot it used last when that slot is
 *   free, since its prompt cache is there. Otherwise it gets the free slot used longest ago (a
 *   slot never used comes first), whose cache is the least likely to be wanted.
 * - A waiting request is told its place in line (1 = next) each time it moves, and stops waiting
 *   at once when its signal aborts.
 */
import {
  type ModelClient,
  ModelError,
  type ModelRequest,
  type ModelStreamEvent,
} from "../contracts/model.ts";

/**
 * The slots of one server that a kind of request may use. A model provider hands out the same
 * object for every connection to that server: the engine keeps one scheduler per object, so the
 * object's identity is what tells it that connections share slots.
 */
export interface SlotPool {
  /** llama-server slot ids (`id_slot`). At least one. */
  readonly slots: readonly number[];
}

export interface SlotRequest {
  /** Who asks: a session id, or an agent within a session. The slot it used last is preferred. */
  owner: string;
  /** Aborting stops the wait at once: `acquire` rejects with a `ModelError` of kind "aborted". */
  signal?: AbortSignal;
  /** Told the place in line (1 = next) when the request starts to wait and each time it moves. */
  onQueue?: (position: number) => void;
}

export interface SlotLease {
  readonly slot: number;
  /** Gives the slot back. Safe to call more than once. */
  release(): void;
}

interface Waiter {
  request: SlotRequest;
  /** The place in line last reported; 0 before the first report. */
  position: number;
  grant(slot: number): void;
}

function abortedWhileWaiting(): ModelError {
  return new ModelError("aborted", "The request was stopped while it waited for the model.");
}

export class SlotScheduler {
  readonly slots: readonly number[];
  readonly #free: Set<number>;
  readonly #queue: Waiter[] = [];
  /** The slot each owner was given last. */
  readonly #lastSlot = new Map<string, number>();
  /** When each slot was last handed out, as a counter. */
  readonly #lastUse = new Map<number, number>();
  #tick = 0;

  constructor(slots: readonly number[]) {
    this.slots = [...new Set(slots)];
    if (this.slots.length === 0) throw new Error("A slot pool needs at least one slot.");
    this.#free = new Set(this.slots);
  }

  /** Requests waiting for a slot. */
  get waiting(): number {
    return this.#queue.length;
  }

  /** Slots handed out and not given back yet. */
  get inUse(): number {
    return this.slots.length - this.#free.size;
  }

  /** Resolves with a slot as soon as one is free and every earlier request has one. */
  acquire(request: SlotRequest): Promise<SlotLease> {
    const signal = request.signal;
    if (signal?.aborted) return Promise.reject(abortedWhileWaiting());
    // The queue only holds requests while every slot is taken.
    if (this.#queue.length === 0 && this.#free.size > 0) {
      return Promise.resolve(this.#lease(request.owner, this.#pick(request.owner)));
    }
    return new Promise<SlotLease>((resolve, reject) => {
      const onAbort = () => {
        const index = this.#queue.indexOf(waiter);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        reject(abortedWhileWaiting());
        this.#announce();
      };
      const waiter: Waiter = {
        request,
        position: 0,
        grant: (slot) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(this.#lease(request.owner, slot));
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(waiter);
      this.#announce();
    });
  }

  /** Drops what is remembered about an owner (its last slot), once it is gone for good. */
  forget(owner: string): void {
    this.#lastSlot.delete(owner);
  }

  #lease(owner: string, slot: number): SlotLease {
    this.#free.delete(slot);
    this.#tick += 1;
    this.#lastSlot.set(owner, slot);
    this.#lastUse.set(slot, this.#tick);
    let released = false;
    return {
      slot,
      release: () => {
        if (released) return;
        released = true;
        this.#free.add(slot);
        this.#dispatch();
      },
    };
  }

  #dispatch(): void {
    let granted = false;
    while (this.#free.size > 0 && this.#queue.length > 0) {
      const next = this.#queue.shift() as Waiter;
      next.grant(this.#pick(next.request.owner));
      granted = true;
    }
    if (granted) this.#announce();
  }

  /** Tells every waiting request whose place in line changed. */
  #announce(): void {
    // A listener may abort another wait, which changes the queue: work from a copy.
    for (const waiter of [...this.#queue]) {
      const position = this.#queue.indexOf(waiter) + 1;
      if (position === 0 || waiter.position === position) continue;
      waiter.position = position;
      try {
        waiter.request.onQueue?.(position);
      } catch {
        // A listener's failure must not stop the others or the scheduler.
      }
    }
  }

  /** A free slot for an owner: its last one when free, else the free slot used longest ago. */
  #pick(owner: string): number {
    const last = this.#lastSlot.get(owner);
    if (last !== undefined && this.#free.has(last)) return last;
    let best: number | null = null;
    let bestUse = Number.POSITIVE_INFINITY;
    for (const slot of this.slots) {
      if (!this.#free.has(slot)) continue;
      const use = this.#lastUse.get(slot) ?? -1;
      if (use < bestUse) {
        best = slot;
        bestUse = use;
      }
    }
    if (best === null) throw new Error("No slot is free.");
    return best;
  }
}

export interface ScheduledClientOptions {
  /** Who the requests are for (see `SlotRequest.owner`). */
  owner: string;
  /**
   * Told the place in line (1 = next) while a request waits for a slot, and null when it stops
   * waiting (given a slot, or aborted). Never called for a request that did not have to wait.
   */
  onQueue?: (position: number | null) => void;
}

/**
 * A client whose every `stream` first takes a slot from `scheduler`, sends the request on that
 * slot (`slot` is set to it, whatever the request said), and gives the slot back when the stream
 * ends: after the last event, on an error, on an abort, or when the reader stops early.
 * `countTokens` goes straight to `client`, since counting holds no slot.
 */
export function scheduledClient(
  client: ModelClient,
  scheduler: SlotScheduler,
  options: ScheduledClientOptions,
): ModelClient {
  return {
    get endpoint() {
      return client.endpoint;
    },
    stream: (request) => streamOnSlot(client, scheduler, options, request),
    countTokens: (request) => client.countTokens(request),
  };
}

async function* streamOnSlot(
  client: ModelClient,
  scheduler: SlotScheduler,
  options: ScheduledClientOptions,
  request: ModelRequest,
): AsyncGenerator<ModelStreamEvent> {
  let queued = false;
  const wait = scheduler.acquire({
    owner: options.owner,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    onQueue: (position) => {
      queued = true;
      options.onQueue?.(position);
    },
  });
  let lease: SlotLease;
  try {
    lease = await wait;
  } finally {
    if (queued) options.onQueue?.(null);
  }
  try {
    yield* client.stream({ ...request, slot: lease.slot });
  } finally {
    lease.release();
  }
}
