/**
 * The real engine (`@dawg/engine`) behind the engine host. One engine for the host's life; each
 * window's port gets its own protocol host (`createEngineHost`) on it. Models come from main
 * through the parent port (`model-provider.ts`).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createEngine, createEngineHost, type Engine } from "@dawg/engine";
import type { Transport } from "@dawg/protocol";
import type { HostToMain } from "../shared/engine-host-messages.ts";
import type { HostedEngine } from "./engine.ts";
import {
  createParentModelProvider,
  type ModelMessage,
  type ParentModelProvider,
  type ParentModelProviderOptions,
} from "./model-provider.ts";
import { profileFor } from "./profiles.ts";

/** What `initialize` reports. */
export const ENGINE_INFO = { name: "dawg", version: "0.0.0" };

export interface RealEngineConfig {
  /** The data root (DAWG_HOME): sessions, plans, logs. */
  dataRoot: string;
  homeDir: string;
  /** The bundled ripgrep, or null to look one up (DAWG_RG_PATH, the checkout's copy, PATH). */
  ripgrepPath: string | null;
  /** Posts a message to main. */
  send(message: HostToMain): void;
  log(message: string): void;
  /** For tests: how long to wait for main to grant a model. */
  grantTimeoutMs?: number;
  /** For tests: how long a turn left running by a closed window goes on. Default 10 minutes. */
  detachGraceMs?: number;
  /** For tests: the client for a granted endpoint. Default `createModelClient`. */
  createClient?: ParentModelProviderOptions["createClient"];
}

export interface RealHostedEngine extends HostedEngine {
  readonly kind: "real";
  readonly engine: Engine;
  readonly models: ParentModelProvider;
  receive(message: ModelMessage): void;
}

/** Throws when the engine cannot start (the data root cannot be created, for one). */
export function createRealEngine(config: RealEngineConfig): RealHostedEngine {
  try {
    mkdirSync(config.dataRoot, { recursive: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`The data folder ${config.dataRoot} cannot be created (${reason})`);
  }
  const models = createParentModelProvider({
    send: config.send,
    log: config.log,
    ...(config.grantTimeoutMs === undefined ? {} : { grantTimeoutMs: config.grantTimeoutMs }),
    ...(config.createClient === undefined ? {} : { createClient: config.createClient }),
  });
  const engine = createEngine({
    storeRoot: config.dataRoot,
    homeDir: config.homeDir,
    models,
    // `endpoint.model` is the model id here (see model-provider.ts).
    profile: (endpoint) =>
      profileFor({
        modelId: endpoint.model,
        serverName: models.serverName(endpoint.model),
        catalogProfile: models.catalogProfile(endpoint.model),
      }),
    ripgrepPath: config.ripgrepPath,
  });
  let disposed: Promise<void> | null = null;
  return {
    kind: "real",
    engine,
    models,
    connect(transport: Transport) {
      createEngineHost(engine, transport, {
        engineInfo: ENGINE_INFO,
        homeDir: config.homeDir,
        describeEndpoint: (session) => models.describe(session.modelInfo().id),
        // The default grace keeps a turn going when its window closes: reopening takes it over.
        ...(config.detachGraceMs === undefined ? {} : { detachGraceMs: config.detachGraceMs }),
        onProblem: (problem) => config.log(`Protocol ${problem.kind}: ${problem.message}`),
      });
    },
    receive: (message) => models.receive(message),
    dispose() {
      // Sessions first: their turns are interrupted, so nothing waits on main any more.
      disposed ??= engine.close().finally(() => models.close());
      return disposed;
    },
  };
}

/** The bundled ripgrep in the app's resources folder: `bin/<platform>-<arch>/rg`. */
export function bundledRipgrepPath(resourcesDir: string): string {
  return path.join(resourcesDir, "bin", `${process.platform}-${process.arch}`, "rg");
}
