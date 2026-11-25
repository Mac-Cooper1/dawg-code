/**
 * Questions about the models state, shared by the store's actions and the model screens.
 */
import type {
  CatalogModel,
  DownloadState,
  ModelOption,
  ModelsState,
  ServerInfo,
} from "../../shared/bridge.ts";
import { shallowEqual } from "./memo.ts";
import type { OnboardingState } from "./types.ts";

/** Phases of a download that still moves on by itself. */
export const RUNNING_PHASES: readonly DownloadState["phase"][] = [
  "queued",
  "checking",
  "downloading",
  "verifying",
];

export function isRunningDownload(download: DownloadState): boolean {
  return RUNNING_PHASES.includes(download.phase);
}

/** Running or paused: a download the person has not finished with. */
export function isUnfinishedDownload(download: DownloadState): boolean {
  return isRunningDownload(download) || download.phase === "paused";
}

export function findDownload(state: ModelsState, modelId: string): DownloadState | undefined {
  return state.downloads.find((download) => download.modelId === modelId);
}

export function findInstalled(state: ModelsState, modelId: string): ModelOption | undefined {
  return state.installed.find((option) => option.id === modelId);
}

export function findCatalogEntry(state: ModelsState, modelId: string): CatalogModel | undefined {
  return state.catalog.find((entry) => entry.id === modelId);
}

/** The server a model id belongs to ("ollama/qwen3:32b" → the "ollama" server). */
export function serverOf(state: ModelsState, modelId: string): ServerInfo | undefined {
  return state.servers.find(
    (server) => server.modelIds.includes(modelId) || modelId.startsWith(`${server.id}/`),
  );
}

/** A model's name for sentences: its label when installed, else the catalog's, else its id. */
export function modelName(state: ModelsState | null, modelId: string): string {
  if (!state) return modelId;
  return (
    findInstalled(state, modelId)?.label ?? findCatalogEntry(state, modelId)?.displayName ?? modelId
  );
}

/**
 * At launch, first run shows while nothing can run, and also while no model is the default yet
 * (for example only a server's models were found: they are offered, never chosen silently).
 */
export function needsSetup(state: ModelsState): boolean {
  return state.installed.length === 0 || state.defaultModelId === null;
}

/** Where first run starts: an unfinished download carries on, else the welcome screen. */
export function firstRunStep(state: ModelsState): OnboardingState {
  const download =
    state.downloads.find(isUnfinishedDownload) ??
    state.downloads.find((candidate) => candidate.phase === "failed");
  if (download) {
    return {
      step: "download",
      modelId: download.modelId,
      error: download.phase === "failed" ? download.error : null,
    };
  }
  return { step: "welcome" };
}

/** The catalog's pick for this Mac, else the first entry that fits; null when nothing fits. */
export function leadModel(state: ModelsState): CatalogModel | null {
  return (
    state.catalog.find((entry) => entry.recommended && entry.fits) ??
    state.catalog.find((entry) => entry.fits) ??
    null
  );
}

/** True when the lists hold equal options in the same order (one level deep). */
export function sameOptions(a: readonly ModelOption[], b: readonly ModelOption[]): boolean {
  return a.length === b.length && a.every((option, index) => shallowEqual(option, b[index]));
}

const FOUND_IN_NAMES: Record<NonNullable<CatalogModel["foundIn"]>, string> = {
  lmstudio: "LM Studio",
  ollama: "Ollama",
  huggingface: "the Hugging Face cache",
};

/** "LM Studio", "Ollama", "the Hugging Face cache". */
export function foundInName(foundIn: NonNullable<CatalogModel["foundIn"]>): string {
  return FOUND_IN_NAMES[foundIn];
}

const SERVER_NAMES: Record<ServerInfo["kind"], string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  remote: "Server",
};

/** "Ollama", "LM Studio", or a remote server's host ("studio.local:8080"). */
export function serverName(server: ServerInfo): string {
  if (server.kind !== "remote") return SERVER_NAMES[server.kind];
  try {
    return new URL(server.url).host || server.url;
  } catch {
    return server.url;
  }
}
