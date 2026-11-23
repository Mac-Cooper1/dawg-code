/**
 * The models this wave pretends are installed. Main serves the list through the bridge, the
 * browser fallback bridge serves the same list, and the mock engine reports the matching
 * `ModelInfo` for sessions. The real model manager (`@dawg/models`) replaces this in a later wave.
 */
import type { ModelInfo } from "@dawg/protocol";
import type { ModelOption, ModelStatus } from "./bridge.ts";

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
      id: "ollama:qwen3.6:35b-a3b",
      label: "Ollama · qwen3.6:35b-a3b",
      shortLabel: "qwen3.6 35B-A3B · Ollama",
      description: "localhost:11434 · 128K context · no prompt cache control",
      source: "server",
      contextWindow: 131_072,
    },
    info: {
      id: "ollama:qwen3.6:35b-a3b",
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
};

export function findMockModel(id: string | null | undefined): MockModel | undefined {
  return MOCK_MODELS.find((model) => model.option.id === id);
}
