import { describe, expect, it } from "vitest";
import {
  CONNECT_MESSAGE,
  createEngineSupervisor,
  type EngineClient,
  type SupervisedChild,
  type Timers,
} from "./engine-supervisor.ts";

/** A port is just a label here: "engine-3" / "client-3" are the two ends of channel 3. */
type Port = string;

class FakeChild implements SupervisedChild<Port> {
  readonly posted: { message: unknown; transfer: Port[] }[] = [];
  killed = false;
  private exitListener: ((code: number | null) => void) | null = null;

  postMessage(message: unknown, transfer: Port[]): void {
    this.posted.push({ message, transfer });
  }
  kill(): void {
    this.killed = true;
    this.exit(null);
  }
  onExit(listener: (code: number | null) => void): void {
    this.exitListener = listener;
  }
  exit(code: number | null): void {
    const listener = this.exitListener;
    this.exitListener = null;
    listener?.(code);
  }
}

class FakeTimers implements Timers {
  private pending = new Map<number, { at: number; callback: () => void }>();
  private next = 1;
  now = 0;

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Delays of the timers waiting now. */
  delays(): number[] {
    return [...this.pending.values()].map((entry) => entry.at - this.now);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, entry] of [...this.pending]) {
      if (entry.at <= this.now) {
        this.pending.delete(id);
        entry.callback();
      }
    }
  }
}

function setup(options: { maxRestarts?: number } = {}) {
  const children: FakeChild[] = [];
  const timers = new FakeTimers();
  const gaveUp: string[] = [];
  let channel = 0;
  const supervisor = createEngineSupervisor<Port>({
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    createChannel: () => {
      channel += 1;
      return { engineEnd: `engine-${channel}`, clientEnd: `client-${channel}` };
    },
    timers,
    now: () => timers.now,
    stableAfterMs: 30_000,
    ...(options.maxRestarts === undefined ? {} : { maxRestarts: options.maxRestarts }),
    onGaveUp: (reason) => gaveUp.push(reason),
  });
  return { supervisor, children, timers, gaveUp };
}

function client(): EngineClient<Port> & { ports: Port[]; restarts: string[] } {
  const ports: Port[] = [];
  const restarts: string[] = [];
  return {
    ports,
    restarts,
    deliverPort: (port) => ports.push(port),
    notifyRestart: (reason) => restarts.push(reason),
  };
}

describe("engine supervisor", () => {
  it("hands each connect a fresh channel: one end to the host, one to the window", () => {
    const { supervisor, children } = setup();
    supervisor.start();
    const window = client();
    supervisor.connect("1", window);
    supervisor.connect("1", window);
    expect(window.ports).toEqual(["client-1", "client-2"]);
    expect(children[0]?.posted).toEqual([
      { message: CONNECT_MESSAGE, transfer: ["engine-1"] },
      { message: CONNECT_MESSAGE, transfer: ["engine-2"] },
    ]);
  });

  it("restarts after an unexpected exit and sends every window a fresh port", () => {
    const { supervisor, children, timers } = setup();
    supervisor.start();
    const a = client();
    const b = client();
    supervisor.connect("a", a);
    supervisor.connect("b", b);

    children[0]?.exit(1);
    expect(a.restarts).toEqual(["The engine host exited (code 1)"]);
    expect(b.restarts).toHaveLength(1);
    expect(supervisor.state).toBe("waiting");
    expect(timers.delays()).toEqual([250]);

    timers.advance(250);
    expect(children).toHaveLength(2);
    expect(supervisor.state).toBe("running");
    expect(a.ports).toEqual(["client-1", "client-3"]);
    expect(b.ports).toEqual(["client-2", "client-4"]);
    expect(children[1]?.posted.map((post) => post.transfer)).toEqual([["engine-3"], ["engine-4"]]);
  });

  it("backs off 250 ms, 1 s, 5 s, then gives up after too many quick failures", () => {
    const { supervisor, children, timers, gaveUp } = setup({ maxRestarts: 4 });
    supervisor.start();
    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      children.at(-1)?.exit(1);
      delays.push(...timers.delays());
      timers.advance(10_000);
    }
    expect(delays).toEqual([250, 1000, 5000, 5000]);
    children.at(-1)?.exit(1);
    expect(supervisor.state).toBe("failed");
    expect(timers.delays()).toEqual([]);
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]).toContain("5 times in a row");
  });

  it("starts the backoff over after a host that ran a while", () => {
    const { supervisor, children, timers } = setup();
    supervisor.start();
    children[0]?.exit(1);
    timers.advance(250);
    children[1]?.exit(1);
    expect(timers.delays()).toEqual([1000]);
    timers.advance(1000);
    timers.advance(60_000);
    children[2]?.exit(1);
    expect(timers.delays()).toEqual([250]);
  });

  it("queues windows that connect while the host is down", () => {
    const { supervisor, children, timers } = setup();
    supervisor.start();
    children[0]?.exit(1);
    const late = client();
    supervisor.connect("late", late);
    expect(late.ports).toEqual([]);
    timers.advance(250);
    expect(late.ports).toEqual(["client-1"]);
  });

  it("restarts at once, with its own reason, from the Developer menu", () => {
    const { supervisor, children, timers } = setup();
    supervisor.start();
    const window = client();
    supervisor.connect("w", window);
    supervisor.restart();
    expect(children[0]?.killed).toBe(true);
    expect(window.restarts[0]).toMatch(/Developer menu/);
    timers.advance(0);
    expect(children).toHaveLength(2);
    expect(window.ports).toEqual(["client-1", "client-2"]);
  });

  it("tries again after giving up when asked", () => {
    const { supervisor, children, timers } = setup({ maxRestarts: 0 });
    supervisor.start();
    const window = client();
    supervisor.connect("w", window);
    children[0]?.exit(1);
    expect(supervisor.state).toBe("failed");
    supervisor.restart();
    expect(supervisor.state).toBe("running");
    expect(window.ports).toEqual(["client-1", "client-2"]);
    expect(timers.delays()).toEqual([]);
  });

  it("forgets closed windows and stays down after stop", () => {
    const { supervisor, children, timers } = setup();
    supervisor.start();
    const window = client();
    supervisor.connect("w", window);
    supervisor.removeClient("w");
    children[0]?.exit(1);
    expect(window.restarts).toEqual([]);
    timers.advance(250);
    expect(window.ports).toEqual(["client-1"]);

    supervisor.stop();
    expect(children[1]?.killed).toBe(true);
    expect(supervisor.state).toBe("stopped");
    timers.advance(10_000);
    expect(children).toHaveLength(2);
  });
});
