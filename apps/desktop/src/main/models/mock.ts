/**
 * The model service with DAWG_ENGINE=mock: the data in shared/mock-models.ts, everything installed
 * and the default model loaded, exactly as the app behaved before the model manager. Actions
 * succeed and change nothing, so the end-to-end tour sees the same screens every run.
 */
import type { CatalogModel, ModelsState, ServerInfo } from "../../shared/bridge.ts";
import { MOCK_DEFAULT_MODEL_ID, MOCK_MODEL_STATUS, MOCK_MODELS } from "../../shared/mock-models.ts";
import type { ModelService } from "./service.ts";

const GB = 1024 ** 3;

export const MOCK_MACHINE: ModelsState["machine"] = {
  chip: "Apple M4 Max",
  arch: "arm64",
  memoryBytes: 64 * GB,
  freeDiskBytes: 812 * 1e9,
  macosVersion: "26.1",
};

/** The whole mock state. Built fresh on every call so callers cannot change the shared data. */
export function mockModelsState(): ModelsState {
  const installed = MOCK_MODELS.map((model) => ({ ...model.option }));
  const catalog: CatalogModel[] = MOCK_MODELS.filter(
    (model) => model.option.source === "bundled",
  ).map((model, index) => ({
    id: model.option.id,
    displayName: model.option.label,
    shortLabel: model.option.shortLabel,
    licence: { spdx: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
    sizeBytes: Math.round(model.option.contextWindow * 140_000),
    memoryBytes: Math.round(model.option.contextWindow * 180_000),
    context: { default: model.option.contextWindow, max: 262_144 },
    capabilities: { tools: true, vision: model.info.vision, reasoning: model.info.reasoning },
    recommended: index === 0,
    fits: true,
    fitNote: null,
    state: "installed",
    foundIn: null,
  }));
  const serverModels = MOCK_MODELS.filter((model) => model.option.source === "server");
  const servers: ServerInfo[] =
    serverModels.length === 0
      ? []
      : [
          {
            id: "ollama",
            kind: "ollama",
            url: "http://localhost:11434",
            reachable: true,
            modelIds: serverModels.map((model) => model.option.id),
            hasKey: false,
          },
        ];
  return {
    machine: { ...MOCK_MACHINE },
    installed,
    catalog,
    downloads: [],
    servers,
    status: { ...MOCK_MODEL_STATUS },
    defaultModelId: MOCK_DEFAULT_MODEL_ID,
    idleUnloadMinutes: null,
  };
}

export function createMockModelService(): ModelService {
  const done = async () => {};
  return {
    init: done,
    dispose: done,
    state: async () => mockModelsState(),
    list: async () => mockModelsState().installed,
    status: async () => ({ ...MOCK_MODEL_STATUS }),
    onState: () => () => {},
    onStatus: () => () => {},
    download: done,
    pauseDownload: done,
    cancelDownload: done,
    dismissDownload: done,
    useExisting: done,
    remove: done,
    start: done,
    stop: done,
    setDefault: done,
    setIdleUnload: done,
    addModelFile: async () => null,
    connectServer: async (input) => ({
      id: "remote:mock00",
      kind: "remote",
      url: new URL(input.url).origin,
      reachable: true,
      modelIds: [],
      hasKey: input.apiKey !== undefined,
    }),
    removeServer: done,
    refreshServers: done,
    // The mock engine never asks; answer plainly in case something does.
    requestModel: async () => ({
      ok: false,
      message: "The mock engine runs without models.",
      retryable: false,
    }),
    onModelsChanged: () => () => {},
  };
}
