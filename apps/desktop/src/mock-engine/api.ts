/**
 * The mock engine's public API. Contract between the mock engine (implemented in this folder),
 * the engine host (`src/engine-host`), the renderer's browser fallback (`src/renderer/bridge`)
 * and tests.
 *
 * The mock engine speaks the real protocol: it is served with `createServer` from
 * @dawg/protocol, so a client cannot tell it from the real engine except by what it says.
 * It must run anywhere: no Node or DOM APIs beyond timers, so the same code runs in the Electron
 * utility process, in a browser tab and in tests.
 */
import type { Transport } from "@dawg/protocol";
import type { LoadedScenario } from "./format.ts";

/** Timers the engine uses, injectable so tests can run a scenario instantly or step by step. */
export interface MockClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface MockEngineOptions {
  /** Expands "~/" in scenario paths. */
  homeDir: string;
  /**
   * Playback speed: 1 plays recordings with their recorded timing (long pauses are capped),
   * 4 plays four times faster, `Infinity` plays everything at once. Default 1.
   */
  speed?: number;
  /** Scenarios to serve. Default: the built-in fixtures (`BUILT_IN_SCENARIOS`). */
  scenarios?: readonly LoadedScenario[];
  /** Default: the real clock. */
  clock?: MockClock;
  /** Reported by `initialize`. Default `{ name: "dawg mock engine", version: "0.0.0" }`. */
  engineInfo?: { name: string; version: string };
}

export interface MockConnection {
  /** Closes this connection. The engine and its sessions keep running. */
  close(): void;
  /** Resolves once the connection has closed, from either side. */
  readonly closed: Promise<void>;
}

export interface MockEngine {
  /**
   * Serves the protocol on one transport. Several connections may be open at once (a reloaded
   * window opens a new one); each receives events only for sessions it created, resumed or
   * forked, as the protocol says.
   */
  connect(transport: Transport): MockConnection;
  /** Stops every playback and timer and closes every connection. */
  dispose(): void;
}

/** Signature of `createMockEngine`, exported from `./index.ts`. */
export type CreateMockEngine = (options: MockEngineOptions) => MockEngine;
