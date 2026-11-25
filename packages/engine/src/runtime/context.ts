/** What every session of one engine shares: dependencies, settings and limits, resolved once. */
import type { SettingsFlags } from "@dawg/compat";
import type { Endpoint } from "@dawg/models";
import type { ClientCapabilities } from "@dawg/protocol";
import type { PermissionEngine } from "../contracts/permissions.ts";
import type {
  Compactor,
  ModelProfile,
  PromptAssembler,
  SessionEnvironment,
  TokenEstimator,
} from "../contracts/prompt.ts";
import type { AnyTool, ToolLimits } from "../contracts/tools.ts";
import type { IdKind } from "../loop/types.ts";
import type { SlotPool, SlotScheduler } from "../model/slots.ts";
import type { SessionStore } from "../session/index.ts";
import type { EnvironmentInput } from "./environment.ts";
import type { LoggedEvent } from "./event-log.ts";
import type { SessionRuntime } from "./session.ts";
import type { ModelProvider, RuntimeLimits } from "./types.ts";

export interface EngineContext {
  store: SessionStore;
  storeRoot: string;
  homeDir: string;
  models: ModelProvider;
  assembler: PromptAssembler;
  compactor: Compactor;
  estimator: TokenEstimator;
  profileFor(endpoint: Endpoint): ModelProfile;
  permissions: PermissionEngine;
  tools: readonly AnyTool[];
  toolMap: ReadonlyMap<string, AnyTool>;
  toolLimits: ToolLimits;
  limits: RuntimeLimits;
  capabilities: ClientCapabilities;
  settingsFlags: SettingsFlags | undefined;
  externalImports: "allow" | "block";
  ripgrepPath: string | null;
  generateTitles: boolean;
  clock(): number;
  newId(kind: IdKind): string;
  environment(input: EnvironmentInput): Promise<SessionEnvironment>;
  /** The scheduler of a pool of model slots: one per pool object, shared by every session. */
  slots(pool: SlotPool): SlotScheduler;
  /** Hands an event to the engine's own listeners. */
  publish(event: LoggedEvent): void;
  /** Called once when a session has closed. */
  onClosed(runtime: SessionRuntime): void;
}
