/**
 * Entry point of the mock engine. Contract: keep these exports and their types.
 *
 * `createMockEngine` serves the protocol and plays the recorded sessions in `./fixtures`
 * (`BUILT_IN_SCENARIOS`) unless given others. `checkConformance` checks any session's event
 * stream against the protocol's ordering rules; `createManualClock` drives playback in tests.
 */
import type { CreateMockEngine } from "./api.ts";
import { createMockEngine as createEngine } from "./engine.ts";
import { BUILT_IN_SCENARIOS } from "./scenarios.ts";

export type { MockClock, MockConnection, MockEngine, MockEngineOptions } from "./api.ts";
export { createManualClock, type ManualClock } from "./clock.ts";
export { type ConformanceOptions, checkConformance } from "./conformance.ts";
export * from "./format.ts";
export { BUILT_IN_SCENARIOS, loadScenarios } from "./scenarios.ts";

export const createMockEngine: CreateMockEngine = (options) =>
  createEngine({ ...options, scenarios: options.scenarios ?? BUILT_IN_SCENARIOS });
