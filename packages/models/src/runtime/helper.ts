/**
 * The helper model's runtime: a second llama-server, beside the main model's, that answers side
 * requests (session titles, WebFetch's page summaries) so they never wait for the main model or
 * take its slots. The app and the command-line tool both lay it out from here and run it under
 * the same supervisor and watchdog as the main runtime, with a port, key file, logs and slot of
 * its own.
 *
 * The person can turn it off (Settings → Models): the choice is a plain setting in
 * `<data root>/helper-model.json`, which the app writes and both read, so the command line
 * follows it too.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { catalogHelper } from "../catalog/recommend.ts";
import { cachePaths } from "../download/paths.ts";
import type { CatalogEntry } from "../types.ts";
import { helperSlotLayout, type RuntimeSettings } from "./args.ts";
import type { RuntimeConfig, SupervisorPaths } from "./supervisor.ts";

/**
 * The helper's settings beside its layout. Each side request is new text (a session's first
 * prompt, a page), so a host-memory prompt cache or context checkpoints would hold nothing worth
 * reusing: both are off, which keeps the helper's memory to its weights and one window.
 * `--reasoning off` makes no-thinking the server's own default, on top of the template option
 * the helper's profile sends with each request.
 */
export const HELPER_RUNTIME_SETTINGS: Pick<
  RuntimeSettings,
  "cacheRamMiB" | "ctxCheckpoints" | "checkpointMinStep" | "reasoning"
> = {
  cacheRamMiB: 0,
  ctxCheckpoints: 0,
  checkpointMinStep: 0,
  reasoning: { mode: "off" },
};

export interface HelperRuntimeInput {
  entry: CatalogEntry;
  modelPath: string;
  /** `--sleep-idle-seconds`: the main model's idle unload, so the helper unloads with it. */
  idleUnloadSeconds?: number;
  /** The helper's window. Default: the entry's default context. */
  contextTokens?: number;
}

/** What a `RuntimeSupervisor` needs for the helper, plus the slot ids side requests use. */
export interface HelperRuntimeConfig extends RuntimeConfig {
  slotIds: number[];
}

export function helperRuntimeConfig(input: HelperRuntimeInput): HelperRuntimeConfig {
  const layout = helperSlotLayout(input.contextTokens ?? input.entry.context.default);
  return {
    model: { path: input.modelPath, catalogEntry: input.entry },
    contextSize: layout.contextSize,
    slots: layout.slots,
    settings: {
      ...HELPER_RUNTIME_SETTINGS,
      reasoning: { ...HELPER_RUNTIME_SETTINGS.reasoning },
      ...layout.settings,
      // The catalog id, so the helper's endpoint names it and its profile is found by it.
      alias: input.entry.id,
      ...(input.idleUnloadSeconds === undefined
        ? {}
        : { idleUnloadSeconds: input.idleUnloadSeconds }),
    },
    slotIds: [...layout.slotIds],
  };
}

/**
 * Where the helper keeps its files under the data root: logs beside the main runtime's with a
 * "helper-" prefix (helper-runtime.log, helper-llama-server.log), and a slot folder of its own.
 */
export function helperPaths(dataRoot: string): SupervisorPaths {
  return {
    slotSaveDir: path.join(dataRoot, "runtime", "helper-slots"),
    logDir: path.join(dataRoot, "logs"),
    logPrefix: "helper-",
  };
}

// ---------------------------------------------------------------------------------------------
// The on/off setting, shared by the app and the command line
// ---------------------------------------------------------------------------------------------

export const HELPER_SETTINGS_FILE = "helper-model.json";

/**
 * Whether side requests go to the helper (`<dataRoot>/helper-model.json`). Missing, unreadable
 * or odd content means on: the helper is used whenever it is installed unless the person turned
 * it off.
 */
export async function readHelperEnabled(dataRoot: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(dataRoot, HELPER_SETTINGS_FILE), "utf8"),
    );
    if (typeof parsed === "object" && parsed !== null) {
      const enabled = (parsed as { enabled?: unknown }).enabled;
      if (enabled === false) return false;
    }
    return true;
  } catch {
    return true;
  }
}

/** Saves the setting atomically, so a reader never sees half a file. */
export async function writeHelperEnabled(dataRoot: string, enabled: boolean): Promise<void> {
  const file = path.join(dataRoot, HELPER_SETTINGS_FILE);
  await mkdir(dataRoot, { recursive: true });
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Finding a downloaded helper
// ---------------------------------------------------------------------------------------------

export interface DownloadedHelper {
  entry: CatalogEntry;
  /** The snapshot path in the Hugging Face cache. */
  modelPath: string;
}

/**
 * The catalog's helper when its file is in the Hugging Face cache, where the app downloads it:
 * the snapshot of its pinned revision, with exactly the catalog's size. The size is enough: the
 * downloader checked the SHA-256 before it put the file there, and hashing a gigabyte at every
 * start would cost more than it guards against. Null when the catalog has no helper or the file
 * is not there.
 */
export async function findDownloadedHelper(options: {
  catalog: readonly CatalogEntry[] | { entries: readonly CatalogEntry[] };
  hubDir: string;
}): Promise<DownloadedHelper | null> {
  const entry = catalogHelper(options.catalog);
  if (entry === null) return null;
  const { source } = entry;
  const paths = cachePaths(
    options.hubDir,
    source.repo,
    source.revision,
    source.file,
    source.sha256,
  );
  try {
    const info = await stat(paths.snapshotPath);
    if (!info.isFile() || info.size !== source.sizeBytes) return null;
  } catch {
    return null;
  }
  return { entry, modelPath: paths.snapshotPath };
}
