/**
 * Keeps the engine host running and hands every window a port to it.
 *
 * Plain logic with the child process, the channel and the timers injected, so it runs in unit
 * tests without Electron. `index.ts` plugs in `utilityProcess.fork` and `MessageChannelMain`.
 *
 * - Each `connect` makes a new channel: one end goes to the engine host with `{ type: "connect" }`,
 *   the other to the window. Streamed events then flow window ⇄ engine host without main.
 * - When the engine host exits unexpectedly, every window is told (it shows a one-line notice),
 *   the host is restarted after a backoff, and every window gets a fresh port without asking.
 * - After too many quick failures in a row it gives up and says so once; `restart()` tries again.
 * - Messages the engine host posts to main (model requests) go to `onMessage`, with a `reply`
 *   that reaches the host that asked, and only while it runs. `post` reaches the current host.
 */

export interface SupervisedChild<Port> {
  postMessage(message: unknown, transfer: Port[]): void;
  kill(): void;
  /** Called once when the process ends, whatever the cause. */
  onExit(listener: (code: number | null) => void): void;
  /** Called for every message the process posts to main. */
  onMessage(listener: (message: unknown) => void): void;
}

export interface EngineClient<Port> {
  deliverPort(port: Port): void;
  notifyRestart(reason: string): void;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface EngineSupervisorOptions<Port> {
  spawn(): SupervisedChild<Port>;
  /** `engineEnd` is posted to the engine host, `clientEnd` delivered to the window. */
  createChannel(): { engineEnd: Port; clientEnd: Port };
  /** Delay before each restart in a row; the last value repeats. Default 250 ms, 1 s, 5 s. */
  backoffMs?: readonly number[];
  /** Restarts in a row allowed before giving up. Default 5. */
  maxRestarts?: number;
  /** A host that ran this long before exiting counts as healthy: the backoff starts over. */
  stableAfterMs?: number;
  timers?: Timers;
  now?: () => number;
  log?: (message: string) => void;
  /** Called when the supervisor stops restarting. `restart()` starts again. */
  onGaveUp?(reason: string): void;
  /**
   * A message from the engine host. `reply` posts back to the host that sent it, and does
   * nothing once that host has exited (its replacement never sees an answer it did not ask for).
   */
  onMessage?(message: unknown, reply: (message: unknown) => void): void;
}

export type SupervisorState = "idle" | "running" | "waiting" | "failed" | "stopped";

export interface EngineSupervisor<Port> {
  readonly state: SupervisorState;
  start(): void;
  /** Gives the client a new port now, or as soon as the engine host is running again. */
  connect(clientId: string, client: EngineClient<Port>): void;
  removeClient(clientId: string): void;
  /**
   * Kills the running engine host so the normal restart path runs (Developer menu). When the
   * supervisor had given up, starts the engine host again.
   */
  restart(reason?: string): void;
  /** Kills the engine host for good (app quit). */
  stop(): void;
  /** Posts a message to the running engine host. False when none runs. */
  post(message: unknown): boolean;
}

export const DEFAULT_BACKOFF_MS = [250, 1000, 5000] as const;
export const CONNECT_MESSAGE = { type: "connect" } as const;

export function createEngineSupervisor<Port>(
  options: EngineSupervisorOptions<Port>,
): EngineSupervisor<Port> {
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxRestarts = options.maxRestarts ?? 5;
  const stableAfterMs = options.stableAfterMs ?? 30_000;
  const timers: Timers = options.timers ?? {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});

  const clients = new Map<string, EngineClient<Port>>();
  /** Clients that asked for a port while the host was down. */
  const waiting = new Set<string>();
  let state: SupervisorState = "idle";
  let child: SupervisedChild<Port> | null = null;
  let startedAt = 0;
  let restartsInARow = 0;
  let restartTimer: unknown = null;
  /** Set when we killed the host on purpose to restart it; used as the reason. */
  let requestedRestart: string | null = null;

  function spawn(): void {
    const next = options.spawn();
    child = next;
    startedAt = now();
    state = "running";
    next.onExit((code) => {
      if (child !== next) return;
      child = null;
      handleExit(code);
    });
    next.onMessage((message) => {
      if (child !== next) return;
      options.onMessage?.(message, (answer) => {
        if (child !== next) return;
        try {
          next.postMessage(answer, []);
        } catch (error) {
          log(`Could not answer the engine host: ${messageOf(error)}`);
        }
      });
    });
  }

  function giveTo(clientId: string): void {
    const client = clients.get(clientId);
    if (!client || !child) return;
    const { engineEnd, clientEnd } = options.createChannel();
    try {
      child.postMessage(CONNECT_MESSAGE, [engineEnd]);
    } catch (error) {
      log(`Could not hand a port to the engine host: ${messageOf(error)}`);
      return;
    }
    client.deliverPort(clientEnd);
  }

  function handleExit(code: number | null): void {
    if (state === "stopped") return;
    const ranFor = now() - startedAt;
    const reason = requestedRestart ?? `The engine host exited (code ${code ?? "unknown"})`;
    const onPurpose = requestedRestart !== null;
    requestedRestart = null;
    if (onPurpose || ranFor >= stableAfterMs) restartsInARow = 0;
    log(`${reason} after ${ranFor} ms.`);

    for (const [id, client] of clients) {
      waiting.add(id);
      client.notifyRestart(reason);
    }

    if (restartsInARow >= maxRestarts) {
      state = "failed";
      const message = `${reason}. It failed ${restartsInARow + 1} times in a row, so it was not restarted.`;
      log(message);
      options.onGaveUp?.(message);
      return;
    }
    const delay = onPurpose ? 0 : (backoff[Math.min(restartsInARow, backoff.length - 1)] ?? 0);
    restartsInARow += 1;
    state = "waiting";
    log(`Restarting the engine host in ${delay} ms (attempt ${restartsInARow}).`);
    restartTimer = timers.setTimeout(() => {
      restartTimer = null;
      if (state !== "waiting") return;
      relaunch();
    }, delay);
  }

  function relaunch(): void {
    spawn();
    for (const id of [...waiting]) {
      waiting.delete(id);
      giveTo(id);
    }
  }

  return {
    get state() {
      return state;
    },
    start() {
      if (state !== "idle") return;
      spawn();
    },
    connect(clientId, client) {
      clients.set(clientId, client);
      if (state === "running") giveTo(clientId);
      else waiting.add(clientId);
    },
    removeClient(clientId) {
      clients.delete(clientId);
      waiting.delete(clientId);
    },
    restart(reason = "The engine host was restarted from the Developer menu") {
      if (state === "running" && child) {
        requestedRestart = reason;
        child.kill();
        return;
      }
      if (state === "failed" || state === "waiting") {
        if (restartTimer !== null) timers.clearTimeout(restartTimer);
        restartTimer = null;
        restartsInARow = 0;
        relaunch();
      }
    },
    stop() {
      state = "stopped";
      if (restartTimer !== null) timers.clearTimeout(restartTimer);
      restartTimer = null;
      const current = child;
      child = null;
      current?.kill();
    },
    post(message) {
      if (state !== "running" || !child) return false;
      try {
        child.postMessage(message, []);
        return true;
      } catch (error) {
        log(`Could not post to the engine host: ${messageOf(error)}`);
        return false;
      }
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
