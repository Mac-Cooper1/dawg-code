/**
 * Builds the engine for one `dawg` process and connects to it through the protocol, exactly as
 * the app will: a protocol client and the engine host joined by an in-memory transport.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { SettingsFlags } from "@dawg/compat";
import {
  createEngine,
  createEngineHost,
  type Engine,
  type EngineHost,
  getModelProfile,
  resolveDawgHome,
} from "@dawg/engine";
import {
  type Client,
  type ClientCapabilities,
  createClient,
  createMemoryTransportPair,
} from "@dawg/protocol";
import type { CliOptions } from "./args.ts";
import type { ModelSetup } from "./models.ts";
import { profileIdForModel } from "./profiles.ts";

export function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface Paths {
  homeDir: string;
  /** The data root: `$DAWG_HOME`, else `~/.dawg`. */
  dawgHome: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv): Paths {
  const homeDir = env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
  return { homeDir, dawgHome: resolveDawgHome({ env, homeDir }) };
}

export function settingsFlagsFrom(options: CliOptions): SettingsFlags {
  const flags: SettingsFlags = {};
  if (options.allowedTools.length > 0) flags.allowedTools = options.allowedTools;
  if (options.disallowedTools.length > 0) flags.disallowedTools = options.disallowedTools;
  if (options.permissionMode !== null) flags.permissionMode = options.permissionMode;
  if (options.addDirs.length > 0) flags.addDirs = options.addDirs;
  return flags;
}

export function buildEngine(input: {
  options: CliOptions;
  paths: Paths;
  models: ModelSetup;
  generateTitles: boolean;
}): Engine {
  const { options, paths, models } = input;
  return createEngine({
    storeRoot: paths.dawgHome,
    homeDir: paths.homeDir,
    models: models.provider,
    profile: (endpoint) => getModelProfile(profileIdForModel(endpoint.model)),
    settingsFlags: settingsFlagsFrom(options),
    generateTitles: input.generateTitles,
    ...(options.maxTurns === null ? {} : { limits: { maxRequestsPerTurn: options.maxTurns } }),
  });
}

export interface InProcess {
  client: Client;
  host: EngineHost;
}

/** A protocol client talking to a host on `engine` in this process. */
export async function connectInProcess(input: {
  engine: Engine;
  options: CliOptions;
  paths: Paths;
  models: ModelSetup;
  capabilities: ClientCapabilities;
  onProblem: (message: string) => void;
}): Promise<InProcess> {
  const [clientEnd, engineEnd] = createMemoryTransportPair();
  const host = createEngineHost(input.engine, engineEnd, {
    engineInfo: { name: "dawg", version: cliVersion() },
    homeDir: input.paths.homeDir,
    settingsFlags: settingsFlagsFrom(input.options),
    describeEndpoint: (session) => input.models.describe(session.modelInfo().id),
    // Nothing outlives this process: a turn left running when the connection closes is stopped.
    detachGraceMs: 0,
    onProblem: (p) => input.onProblem(`${p.kind}: ${p.message}`),
  });
  // Turns can wait on the person for as long as they like; requests are answered promptly.
  const client = createClient(clientEnd, {
    timeoutMs: 0,
    onProblem: (p) => input.onProblem(`${p.kind}: ${p.message}`),
  });
  await client.initialize({
    client: { name: "dawg-cli", version: cliVersion() },
    capabilities: input.capabilities,
  });
  return { client, host };
}
