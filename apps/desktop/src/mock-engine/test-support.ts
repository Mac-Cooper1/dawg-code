/**
 * Test helpers: an engine on a manual clock, clients over memory transports, and event
 * collection. Used by this folder's tests only.
 */
import {
  type Client,
  createClient,
  createMemoryTransportPair,
  type EngineEvent,
  type MethodName,
  type MethodParams,
  type MethodResult,
  RpcError,
} from "@dawg/protocol";
import type { MockEngine } from "./api.ts";
import { createManualClock, type ManualClock } from "./clock.ts";
import { createMockEngine, type EngineOptions } from "./engine.ts";
import type { LoadedScenario } from "./format.ts";
import { BUILT_IN_SCENARIOS } from "./scenarios.ts";

export const HOME = "/Users/tester";

/** Lets queued microtasks (memory transport deliveries, handler awaits) run. */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export interface Peer {
  client: Client;
  /** Every event received, in order. */
  events: EngineEvent[];
  /** Events dropped by the client as invalid. */
  problems: string[];
  of(sessionId: string): EngineEvent[];
  request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  /** The error a request fails with. */
  failure<M extends MethodName>(method: M, params: MethodParams<M>): Promise<RpcError>;
  close(): void;
}

export interface Harness {
  clock: ManualClock;
  engine: MockEngine;
  /** Opens an initialized client. */
  connect(): Promise<Peer>;
  /** Moves the clock and lets the deliveries land. */
  advance(ms: number): Promise<void>;
  /** Plays everything that is scheduled, then lets the deliveries land. */
  runAll(): Promise<void>;
}

export function harness(
  options: {
    speed?: number;
    scenarios?: readonly LoadedScenario[];
    startPlayback?: EngineOptions["startPlayback"];
    clock?: ManualClock;
  } = {},
): Harness {
  const clock = options.clock ?? createManualClock();
  const engine = createMockEngine({
    homeDir: HOME,
    speed: options.speed ?? 1,
    clock,
    scenarios: options.scenarios ?? BUILT_IN_SCENARIOS,
    ...(options.startPlayback === undefined ? {} : { startPlayback: options.startPlayback }),
  });
  return {
    clock,
    engine,
    async connect() {
      const [clientEnd, engineEnd] = createMemoryTransportPair();
      engine.connect(engineEnd);
      const problems: string[] = [];
      const client = createClient(clientEnd, {
        timeoutMs: 0,
        onProblem: (problem) => problems.push(problem.message),
      });
      const events: EngineEvent[] = [];
      client.onEvent((event) => events.push(event));
      await client.initialize({ client: { name: "test", version: "0.0.0" }, capabilities: {} });
      return {
        client,
        events,
        problems,
        of: (sessionId) => events.filter((e) => e.payload.sessionId === sessionId),
        request: (method, params) => client.request(method, params),
        async failure(method, params) {
          try {
            await client.request(method, params);
          } catch (error) {
            if (error instanceof RpcError) return error;
            throw error;
          }
          throw new Error(`${method} succeeded`);
        },
        close: () => client.close(),
      };
    },
    async advance(ms) {
      clock.advance(ms);
      await flush();
    },
    async runAll() {
      clock.runAll();
      await flush();
    },
  };
}

/** The scenario with this id among the built-in ones. */
export function builtIn(id: string): LoadedScenario {
  const found = BUILT_IN_SCENARIOS.find((s) => s.scenario.id === id);
  if (found === undefined) throw new Error(`No built-in scenario ${id}`);
  return found;
}

/** Event names, for comparing orders. */
export function names(events: readonly EngineEvent[]): string[] {
  return events.map((e) => e.event);
}

/** The first event of a kind, or a test failure. */
export function first<E extends EngineEvent["event"]>(
  events: readonly EngineEvent[],
  name: E,
): Extract<EngineEvent, { event: E }> {
  const found = events.find((e) => e.event === name);
  if (found === undefined) throw new Error(`No ${name} event`);
  return found as Extract<EngineEvent, { event: E }>;
}

/** Every event of a kind. */
export function all<E extends EngineEvent["event"]>(
  events: readonly EngineEvent[],
  name: E,
): Extract<EngineEvent, { event: E }>[] {
  return events.filter((e) => e.event === name) as Extract<EngineEvent, { event: E }>[];
}
