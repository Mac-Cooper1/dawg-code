/**
 * Shared types for the model layer. See docs/specs/phase-1-model-layer.md.
 *
 * This file is the contract between the catalog/download side and the
 * runtime/endpoint side of the package. Change it deliberately.
 */

export type ChipClass = "base" | "pro" | "max" | "ultra" | "intel";

export interface HardwareProfile {
  arch: "arm64" | "x64";
  /** Marketing name of the chip, for example "Apple M4 Max". */
  chip: string;
  chipClass: ChipClass;
  memoryBytes: number;
  performanceCores: number;
  /** Free space on the volume that holds the model cache. */
  freeDiskBytes: number;
  macosVersion: string;
}

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
}

export interface CatalogFile {
  file: string;
  sha256: string;
  sizeBytes: number;
}

export interface CatalogEntry {
  /** Stable identifier, for example "qwen3.8-27b-q8". */
  id: string;
  displayName: string;
  licence: { spdx: string; url: string };
  /** `revision` is a commit hash, never a branch, so an entry always means the same bytes. */
  source: CatalogFile & { repo: string; revision: string };
  /** Vision projector file from the same repo and revision, when the model has one. */
  projector?: CatalogFile;
  minMemoryBytes: number;
  /** Omitted means any Apple Silicon chip. */
  chipClasses?: ChipClass[];
  context: { default: number; max: number };
  capabilities: ModelCapabilities;
  /** Id of the per-model profile (sampler, reasoning and template settings). */
  profile: string;
  /** Order among entries that fit the same machine. Higher wins. */
  rank: number;
}

export type EndpointKind = "bundled" | "ollama" | "lmstudio" | "remote";

export interface Endpoint {
  kind: EndpointKind;
  /** OpenAI-compatible root, including the `/v1` segment. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** The real context window, as reported by the server. */
  contextWindow: number;
  capabilities: ModelCapabilities & {
    /** Slots, prompt warm-up and cache save/restore are available. */
    cacheControl: boolean;
  };
  /** What the model's chat template supports, where the server reports it. */
  template?: {
    parallelToolCalls?: boolean;
    /** Effort levels the template accepts, weakest first. Empty or absent means none. */
    reasoningEffortLevels?: string[];
  };
}
