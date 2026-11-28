/** Everything a run needs, started in order and stopped in reverse. */
import {
  createSearchProvider,
  type Engine,
  type EngineHost,
  readSearchSettings,
  type SearchProvider,
  searchConfigFromEnvironment,
} from "@dawg/engine";
import type { Client, ClientCapabilities } from "@dawg/protocol";
import type { CliOptions } from "./args.ts";
import { buildEngine, connectInProcess, type Paths, resolvePaths } from "./engine.ts";
import { EXIT } from "./exit-codes.ts";
import type { Io } from "./io.ts";
import { type ModelSetup, ModelSetupError, setupModels } from "./models.ts";
import { RunError } from "./session.ts";

export interface Running {
  paths: Paths;
  models: ModelSetup;
  engine: Engine;
  client: Client;
  host: EngineHost;
  /** Closes the connection, the engine and the bundled runtime. Safe to call more than once. */
  close(): Promise<void>;
}

export async function startModels(
  options: CliOptions,
  io: Io,
  log: (line: string) => void,
): Promise<{ paths: Paths; models: ModelSetup }> {
  const paths = resolvePaths(io.env);
  try {
    const models = await setupModels({
      endpoint: options.endpoint,
      modelFile: options.modelFile,
      contextSize: options.contextSize,
      model: options.model,
      env: io.env,
      dawgHome: paths.dawgHome,
      log,
    });
    return { paths, models };
  } catch (error) {
    if (error instanceof ModelSetupError) {
      throw new RunError(error.kind === "usage" ? EXIT.usage : EXIT.error, error.message);
    }
    throw error;
  }
}

export async function start(
  options: CliOptions,
  io: Io,
  input: {
    capabilities: ClientCapabilities;
    generateTitles: boolean;
    log: (line: string) => void;
    verbose: (line: string) => void;
  },
): Promise<Running> {
  const { paths, models } = await startModels(options, io, input.verbose);
  let engine: Engine | null = null;
  try {
    const search = await searchFromEnvironment(io.env, paths.dawgHome, input.log);
    engine = buildEngine({
      options,
      paths,
      models,
      generateTitles: input.generateTitles,
      search,
      env: io.env,
    });
    const { client, host } = await connectInProcess({
      engine,
      options,
      paths,
      models,
      capabilities: input.capabilities,
      onProblem: input.verbose,
    });
    const opened = engine;
    let closing: Promise<void> | null = null;
    return {
      paths,
      models,
      engine: opened,
      client,
      host,
      close() {
        closing ??= (async () => {
          client.close();
          await host.done;
          await opened.close().catch(() => {});
          await models.close();
        })();
        return closing;
      },
    };
  } catch (error) {
    await engine?.close().catch(() => {});
    await models.close();
    throw error;
  }
}

/**
 * The search service WebSearch uses on the command line: DAWG_SEARCH_PROVIDER (brave, tavily or
 * searxng; Brave when only a key is set), DAWG_SEARCH_API_KEY and DAWG_SEARXNG_URL, over the choice saved in
 * `<data root>/web-search.json` (which never holds a key). Without one, WebSearch is not offered.
 * A service asked for but unusable (no key) is reported once and left off.
 */
export async function searchFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  dawgHome: string,
  log: (line: string) => void,
): Promise<SearchProvider | null> {
  const { config, problem } = searchConfigFromEnvironment(env, await readSearchSettings(dawgHome));
  if (problem !== null) log(problem);
  return config === null ? null : createSearchProvider(config);
}
