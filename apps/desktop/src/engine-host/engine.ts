/**
 * The one seam where the engine host picks its engine: the real engine (`@dawg/engine`, see
 * `real-engine.ts`) unless DAWG_ENGINE=mock, which replays recorded sessions
 * (`src/mock-engine`) and never asks main for a model.
 */
import type { Transport } from "@dawg/protocol";
import { createMockEngine } from "../mock-engine/index.ts";
import type { HostToMain } from "../shared/engine-host-messages.ts";
import type { ModelMessage } from "./model-provider.ts";
import { createRealEngine } from "./real-engine.ts";

export type EngineKind = "mock" | "real";

export interface HostedEngine {
  readonly kind: EngineKind;
  /** Serves the protocol on one transport (one window's port). */
  connect(transport: Transport): void;
  /** One of main's messages about models. The mock engine has no use for them. */
  receive?(message: ModelMessage): void;
  /** Stops the engine: open sessions are closed and their transcripts flushed. */
  dispose(): void | Promise<void>;
}

export type EngineConfig =
  | {
      kind: "mock";
      homeDir: string;
      /** Playback speed (DAWG_MOCK_SPEED). */
      speed: number;
    }
  | {
      kind: "real";
      homeDir: string;
      /** The data root (DAWG_HOME). */
      dataRoot: string;
      /** The bundled ripgrep, or null to look one up. */
      ripgrepPath: string | null;
      log(message: string): void;
    };

/** `send` posts a message to main; only the real engine uses it. */
export function createHostedEngine(
  config: EngineConfig,
  send: (message: HostToMain) => void,
): HostedEngine {
  if (config.kind === "real") {
    return createRealEngine({
      dataRoot: config.dataRoot,
      homeDir: config.homeDir,
      ripgrepPath: config.ripgrepPath,
      send,
      log: config.log,
    });
  }
  const engine = createMockEngine({ homeDir: config.homeDir, speed: config.speed });
  return {
    kind: "mock",
    connect: (transport) => {
      engine.connect(transport);
    },
    dispose: () => engine.dispose(),
  };
}

/** DAWG_ENGINE: "mock" for the mock engine; unset, empty or "real" for the real one. */
export function parseEngineKind(
  raw: string | undefined,
  log: (message: string) => void,
): EngineKind {
  const value = raw?.trim() ?? "";
  if (value === "mock") return "mock";
  if (value !== "" && value !== "real") {
    log(`Ignoring DAWG_ENGINE="${raw}": it must be "mock" or "real". Running the real engine.`);
  }
  return "real";
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
