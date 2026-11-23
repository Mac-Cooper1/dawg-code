/**
 * The one seam where the engine host picks its engine.
 *
 * This wave serves the mock engine. The real engine plugs in here later, without touching the
 * rest of the engine host:
 *
 *   const engine = createEngine({ storeRoot: dataRoot, homeDir, models, ... });   // @dawg/engine
 *   return {
 *     kind: "real",
 *     connect: (transport) => createEngineHost(engine, transport, { homeDir, ... }),
 *     dispose: () => engine.close(),
 *   };
 *
 * (`createEngineHost` serves one connection; see packages/engine/src/host/README.md.)
 */
import type { Transport } from "@dawg/protocol";
import { createMockEngine } from "../mock-engine/index.ts";

export interface HostedEngine {
  readonly kind: "mock" | "real";
  /** Serves the protocol on one transport (one window's port). */
  connect(transport: Transport): void;
  dispose(): void;
}

export interface EngineConfig {
  homeDir: string;
  /** Mock playback speed (DAWG_MOCK_SPEED). */
  speed: number;
}

export function createHostedEngine(config: EngineConfig): HostedEngine {
  const engine = createMockEngine({ homeDir: config.homeDir, speed: config.speed });
  return {
    kind: "mock",
    connect: (transport) => {
      engine.connect(transport);
    },
    dispose: () => engine.dispose(),
  };
}

/**
 * DAWG_MOCK_SPEED: a positive number, or "Infinity" for instant playback. Anything else is
 * reported and replaced by 1 (recorded timing).
 */
export function parseSpeed(raw: string | undefined, log: (message: string) => void): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const value = raw.trim() === "Infinity" ? Number.POSITIVE_INFINITY : Number(raw);
  if (value > 0) return value;
  log(`Ignoring DAWG_MOCK_SPEED="${raw}": it must be a positive number or "Infinity".`);
  return 1;
}
