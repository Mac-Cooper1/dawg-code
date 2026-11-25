/**
 * The models this wave pretends are installed. Main serves the list through the bridge, the
 * browser fallback bridge serves the same list, and the mock engine reports the matching
 * `ModelInfo` for sessions. The real model manager (`@dawg/models`) replaces this in a later wave.
 *
 * `mockModelsState()` builds a whole `ModelsState` around them (a Mac, a catalog, servers) for
 * the browser fallback's fake model manager and the renderer's tests.
 */
import type { ModelInfo } from "@dawg/protocol";
import type {
  CatalogModel,
  MachineInfo,
  ModelOption,
  ModelStatus,
  ModelsState,
  ServerInfo,
} from "./bridge.ts";

export interface MockModel {
  option: ModelOption;
  info: ModelInfo;
}

export const MOCK_MODELS: readonly MockModel[] = [
  {
    option: {
      id: "qwen3.8-27b-q8",
      label: "Qwen3.8 27B (8-bit)",
      shortLabel: "Qwen3.8 27B · 8-bit",
      description: "Bundled runtime · 204.8K context · loaded",
      source: "bundled",
      contextWindow: 204_800,
      origin: "catalog",
      removable: true,
    },
    info: {
      id: "qwen3.8-27b-q8",
      contextWindow: 204_800,
      vision: true,
      reasoning: true,
      effortLevels: ["low", "medium", "high", "xhigh"],
    },
  },
  {
    option: {
      id: "qwen3.8-27b-q6",
      label: "Qwen3.8 27B (6-bit)",
      shortLabel: "Qwen3.8 27B · 6-bit",
      description: "Bundled runtime · 128K context · switching reloads the model",
      source: "bundled",
      contextWindow: 131_072,
      origin: "catalog",
      removable: true,
    },
    info: {
      id: "qwen3.8-27b-q6",
      contextWindow: 131_072,
      vision: true,
      reasoning: true,
      effortLevels: ["low", "medium", "high", "xhigh"],
    },
  },
  {
    option: {
      id: "gpt-oss-20b-q4",
      label: "gpt-oss 20B (4-bit)",
      shortLabel: "gpt-oss 20B · 4-bit",
      description: "Found in LM Studio’s folder · 64K context · text only",
      source: "bundled",
      contextWindow: 65_536,
      origin: "lmstudio",
      removable: false,
    },
    info: {
      id: "gpt-oss-20b-q4",
      contextWindow: 65_536,
      vision: false,
      reasoning: true,
      effortLevels: ["low", "medium", "high"],
    },
  },
  {
    option: {
      id: "ollama/qwen3.6:35b-a3b",
      label: "Ollama · qwen3.6:35b-a3b",
      shortLabel: "qwen3.6 35B-A3B · Ollama",
      description: "localhost:11434 · 128K context · no prompt cache control",
      source: "server",
      contextWindow: 131_072,
      origin: "ollama",
      removable: false,
    },
    info: {
      id: "ollama/qwen3.6:35b-a3b",
      contextWindow: 131_072,
      vision: false,
      reasoning: true,
      effortLevels: ["low", "medium", "high"],
    },
  },
];

export const MOCK_DEFAULT_MODEL_ID = "qwen3.8-27b-q8";

export const MOCK_MODEL_STATUS: ModelStatus = {
  state: "ready",
  modelId: MOCK_DEFAULT_MODEL_ID,
  label: "Qwen3.8 27B · 8-bit",
  message: null,
  memoryBytes: 31_500_000_000,
};

export function findMockModel(id: string | null | undefined): MockModel | undefined {
  return MOCK_MODELS.find((model) => model.option.id === id);
}

// ---------------------------------------------------------------------------------------------
// A whole models state: the Mac, the catalog and the servers
// ---------------------------------------------------------------------------------------------

const GIB = 2 ** 30;

const APACHE_2 = { spdx: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" };

/** The approved mockup's Mac. */
export const MOCK_MACHINE: MachineInfo = {
  chip: "Apple M4 Max",
  arch: "arm64",
  memoryBytes: 64 * GIB,
  freeDiskBytes: 1_210_000_000_000,
  macosVersion: "26.1",
};

/** A Mac too small for every catalog model. */
export const MOCK_SMALL_MACHINE: MachineInfo = {
  chip: "Apple M2",
  arch: "arm64",
  memoryBytes: 16 * GIB,
  freeDiskBytes: 180_400_000_000,
  macosVersion: "15.6",
};

/**
 * The catalog as it stands on `MOCK_MACHINE` with every mock model installed. Every entry that
 * fits is one of `MOCK_MODELS`, so the mock engine knows whatever the person picks.
 */
export const MOCK_CATALOG: readonly CatalogModel[] = [
  {
    id: "qwen3.8-27b-q8",
    displayName: "Qwen3.8 27B (8-bit)",
    shortLabel: "Qwen3.8 27B · 8-bit",
    licence: APACHE_2,
    sizeBytes: 30_000_000_000,
    memoryBytes: 43 * GIB,
    context: { default: 204_800, max: 262_144 },
    capabilities: { tools: true, vision: true, reasoning: true },
    recommended: true,
    fits: true,
    fitNote: null,
    state: "installed",
    foundIn: null,
  },
  {
    id: "qwen3.8-27b-q6",
    displayName: "Qwen3.8 27B (6-bit)",
    shortLabel: "Qwen3.8 27B · 6-bit",
    licence: APACHE_2,
    sizeBytes: 22_900_000_000,
    memoryBytes: 34 * GIB,
    context: { default: 131_072, max: 262_144 },
    capabilities: { tools: true, vision: true, reasoning: true },
    recommended: false,
    fits: true,
    fitNote: null,
    state: "installed",
    foundIn: null,
  },
  {
    id: "gpt-oss-20b-q4",
    displayName: "gpt-oss 20B (4-bit)",
    shortLabel: "gpt-oss 20B · 4-bit",
    licence: APACHE_2,
    sizeBytes: 11_600_000_000,
    memoryBytes: 18 * GIB,
    context: { default: 65_536, max: 131_072 },
    capabilities: { tools: true, vision: false, reasoning: true },
    recommended: false,
    fits: true,
    fitNote: null,
    state: "installed",
    foundIn: "lmstudio",
  },
  {
    id: "qwen3.6-122b-a10b-q6",
    displayName: "Qwen3.6 122B-A10B (6-bit)",
    shortLabel: "Qwen3.6 122B-A10B · 6-bit",
    licence: APACHE_2,
    sizeBytes: 100_200_000_000,
    memoryBytes: 104 * GIB,
    context: { default: 131_072, max: 262_144 },
    capabilities: { tools: true, vision: false, reasoning: true },
    recommended: false,
    fits: false,
    fitNote: "Needs 104 GB of memory; this Mac has 64 GB.",
    state: "available",
    foundIn: null,
  },
];

export const MOCK_SERVERS: readonly ServerInfo[] = [
  {
    id: "ollama",
    kind: "ollama",
    url: "http://localhost:11434",
    reachable: true,
    modelIds: ["ollama/qwen3.6:35b-a3b"],
    hasKey: false,
  },
  {
    id: "lmstudio",
    kind: "lmstudio",
    url: "http://localhost:1234",
    reachable: false,
    modelIds: [],
    hasKey: false,
  },
];

/**
 * - "installed": every mock model installed and the default one loaded (main's mock mode).
 * - "empty": a first launch on `MOCK_MACHINE`: nothing installed, gpt-oss found in LM Studio.
 * - "small": a first launch on a Mac no catalog model fits.
 */
export type MockModelsScenario = "installed" | "empty" | "small";

export function mockModelsState(scenario: MockModelsScenario = "installed"): ModelsState {
  if (scenario === "installed") {
    return {
      machine: { ...MOCK_MACHINE },
      installed: MOCK_MODELS.map((model) => ({ ...model.option })),
      catalog: MOCK_CATALOG.map((entry) => ({ ...entry })),
      downloads: [],
      servers: MOCK_SERVERS.map((server) => ({ ...server, modelIds: [...server.modelIds] })),
      status: { ...MOCK_MODEL_STATUS },
      defaultModelId: MOCK_DEFAULT_MODEL_ID,
      idleUnloadMinutes: null,
    };
  }
  const stopped: ModelStatus = {
    state: "stopped",
    modelId: null,
    label: null,
    message: "Nothing loaded",
    memoryBytes: null,
  };
  if (scenario === "empty") {
    return {
      machine: { ...MOCK_MACHINE },
      installed: [],
      catalog: MOCK_CATALOG.map((entry) => ({
        ...entry,
        state: "available" as const,
      })),
      downloads: [],
      servers: [],
      status: stopped,
      defaultModelId: null,
      idleUnloadMinutes: null,
    };
  }
  const memory = MOCK_SMALL_MACHINE.memoryBytes / GIB;
  return {
    machine: { ...MOCK_SMALL_MACHINE },
    installed: [],
    catalog: MOCK_CATALOG.map((entry) => ({
      ...entry,
      recommended: false,
      fits: false,
      fitNote: `Needs ${Math.round(entry.memoryBytes / GIB)} GB of memory; this Mac has ${memory} GB.`,
      state: "available" as const,
      foundIn: null,
    })),
    downloads: [],
    servers: [],
    status: stopped,
    defaultModelId: null,
    idleUnloadMinutes: null,
  };
}
