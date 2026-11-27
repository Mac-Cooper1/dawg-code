/**
 * Scheduling agents on one model (Phase 4 spec, "Scheduling on one model"; PLAN.md section 7,
 * "Many subagents, one GPU").
 *
 * Each running agent needs a cache slot of its own, or agents evict each other's prompt caches
 * request by request. So a subagent starts only when a seat is free, and a model has as many
 * seats as its pool has conversation slots (whatever the grant offers: one, two, or more).
 *
 * - A main conversation holds a seat while its turn runs. It is never refused one: sessions
 *   already share slots request by request (../model/slots.ts), and a person's own turn does not
 *   wait for agents.
 * - While a main conversation waits on its foreground agents, it lends its seat: it makes no
 *   requests meanwhile, so one of its agents runs on that slot (a fork there reuses its cache).
 * - A subagent waits for a free seat, first come first served, and is told its place in line;
 *   it holds the seat until its task ends.
 *
 * With one slot: an idle session's background agent runs at once; while its turn runs, the agent
 * queues; a foreground agent runs in the parent's place. With two: the main conversation and one
 * agent run side by side, or two agents while the parent waits. With three: two agents beside it.
 *
 * A server whose slots are not ours (no pool) has no seats to count: every agent starts at once
 * and the server queues requests itself.
 */
import type { SlotScheduler } from "../model/slots.ts";

export interface SeatRequest {
  /** Who waits: the agent's session id. */
  owner: string;
  /** Aborting stops the wait at once; `admit` then rejects. */
  signal?: AbortSignal;
  /** Told the place in line (1 = next) when it starts to wait and each time it moves. */
  onQueue?: (position: number) => void;
}

export interface Seat {
  /** Gives the seat back. Safe to call more than once. */
  release(): void;
}

interface Waiter {
  request: SeatRequest;
  position: number;
  grant(): void;
}

interface Main {
  /** A turn runs. */
  active: boolean;
  /** Foreground agents it waits on: while above 0 its seat is lent. */
  lent: number;
}

export class AgentSeats {
  readonly capacity: number;
  /** Seats held by agents. */
  #agents = 0;
  readonly #mains = new Map<string, Main>();
  readonly #queue: Waiter[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  /** Seats in use: running agents, and main conversations that run and lend nothing. */
  get taken(): number {
    let mains = 0;
    for (const main of this.#mains.values()) if (main.active && main.lent === 0) mains += 1;
    return this.#agents + mains;
  }

  /** Agents waiting for a seat. */
  get waiting(): number {
    return this.#queue.length;
  }

  /** A main conversation's turn started or ended. */
  setActive(owner: string, active: boolean): void {
    const main = this.#main(owner);
    main.active = active;
    if (!active && main.lent === 0) this.#mains.delete(owner);
    this.#dispatch();
  }

  /**
   * A main conversation waits on a foreground agent: its seat is lent until the returned function
   * is called. Nested calls count.
   */
  lend(owner: string): () => void {
    const main = this.#main(owner);
    main.lent += 1;
    this.#dispatch();
    let returned = false;
    return () => {
      if (returned) return;
      returned = true;
      main.lent = Math.max(0, main.lent - 1);
      if (!main.active && main.lent === 0) this.#mains.delete(owner);
    };
  }

  /** Resolves with a seat once one is free and every agent that asked earlier has one. */
  admit(request: SeatRequest): Promise<Seat> {
    if (request.signal?.aborted) return Promise.reject(stoppedWhileQueued());
    if (this.#queue.length === 0 && this.taken < this.capacity) {
      return Promise.resolve(this.#seat());
    }
    return new Promise<Seat>((resolve, reject) => {
      const onAbort = () => {
        const index = this.#queue.indexOf(waiter);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        reject(stoppedWhileQueued());
        this.#announce();
      };
      const waiter: Waiter = {
        request,
        position: 0,
        grant: () => {
          request.signal?.removeEventListener("abort", onAbort);
          resolve(this.#seat());
        },
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(waiter);
      this.#announce();
    });
  }

  #main(owner: string): Main {
    let main = this.#mains.get(owner);
    if (main === undefined) {
      main = { active: false, lent: 0 };
      this.#mains.set(owner, main);
    }
    return main;
  }

  #seat(): Seat {
    this.#agents += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#agents -= 1;
        this.#dispatch();
      },
    };
  }

  #dispatch(): void {
    let granted = false;
    while (this.#queue.length > 0 && this.taken < this.capacity) {
      (this.#queue.shift() as Waiter).grant();
      granted = true;
    }
    if (granted) this.#announce();
  }

  #announce(): void {
    for (const waiter of [...this.#queue]) {
      const position = this.#queue.indexOf(waiter) + 1;
      if (position === 0 || waiter.position === position) continue;
      waiter.position = position;
      try {
        waiter.request.onQueue?.(position);
      } catch {
        // One listener's failure must not stop the others.
      }
    }
  }
}

export class StoppedWhileQueuedError extends Error {
  constructor() {
    super("The agent was stopped while it waited for the model.");
    this.name = "AbortError";
  }
}

function stoppedWhileQueued(): Error {
  return new StoppedWhileQueuedError();
}

/** One set of seats per slot scheduler: every session on one server shares them. */
const SEATS = new WeakMap<SlotScheduler, AgentSeats>();

/** The seats of a server's slots, or null for a server whose slots are not ours. */
export function seatsFor(scheduler: SlotScheduler | null): AgentSeats | null {
  if (scheduler === null) return null;
  let seats = SEATS.get(scheduler);
  if (seats === undefined) {
    seats = new AgentSeats(scheduler.slots.length);
    SEATS.set(scheduler, seats);
  }
  return seats;
}
