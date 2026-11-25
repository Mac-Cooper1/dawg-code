/**
 * Messages between main and the engine host, over the utility process's parent port.
 *
 * Main owns the models: downloads, the bundled runtime (llama-server) and the servers. The engine
 * host runs the engine and asks main for a model whenever a session needs one, so a model loads
 * when a session first uses it, and a runtime that restarted is found again.
 *
 * Both sides check what they receive against these schemas and log and drop what does not parse.
 * Only main and the engine host use this file; it imports nothing from Node so the renderer's
 * type-check can include `src/shared`.
 *
 * This file is a contract between two directories. Add to it freely; rename or remove only
 * deliberately.
 */
import { z } from "zod";

/** Where a model is served and what it can do: the shape of `Endpoint` in @dawg/models. */
export const ModelEndpointSchema = z.object({
  kind: z.enum(["bundled", "ollama", "lmstudio", "remote"]),
  /** OpenAI-compatible root, including `/v1`. */
  baseUrl: z.string().min(1),
  /** For a remote server that wants one. Read from the Keychain by main; never logged. */
  apiKey: z.string().optional(),
  /** The name the server knows the model by, sent in each request's `model` field. */
  model: z.string(),
  contextWindow: z.number().int().nonnegative(),
  capabilities: z.object({
    tools: z.boolean(),
    vision: z.boolean(),
    reasoning: z.boolean(),
    /** Slots, prompt warm-up and cache save/restore are available (the bundled runtime). */
    cacheControl: z.boolean(),
  }),
  template: z
    .object({
      parallelToolCalls: z.boolean().optional(),
      /** Effort levels the template accepts, weakest first. */
      reasoningEffortLevels: z.array(z.string()).optional(),
    })
    .optional(),
});
export type ModelEndpoint = z.infer<typeof ModelEndpointSchema>;

/** A model a session may use now, as main hands it to the engine host. */
export const ModelGrantSchema = z.object({
  /**
   * The id sessions use ("qwen3.8-27b-q8", "ollama/qwen3:32b"); see "Model ids" in bridge.ts.
   * It can differ from `endpoint.model`, which is the server's own name for the model.
   */
  modelId: z.string().min(1),
  endpoint: ModelEndpointSchema,
  /**
   * The bundled runtime's slots, which the engine schedules between sessions: the conversation
   * slots they share, and the slots for side requests (titles). Absent for servers, whose
   * requests go out at once.
   */
  slots: z
    .object({
      conversation: z.array(z.number().int().nonnegative()).min(1),
      utility: z.array(z.number().int().nonnegative()).min(1),
    })
    .optional(),
  /**
   * Grows whenever what serves the model changes (the runtime restarted on another port, or
   * loaded another model), so the engine host can tell a grant it holds is out of date.
   */
  generation: z.number().int().nonnegative(),
  /**
   * The engine model profile the catalog names for this model (`CatalogEntry.profile`: sampling,
   * output cap, compaction threshold). Absent when main does not know one (a server's model, a
   * file added by hand); the engine host then picks a profile by the model's family.
   */
  profile: z.string().min(1).optional(),
});
export type ModelGrant = z.infer<typeof ModelGrantSchema>;

/** Engine host → main. */
export const HostToMainSchema = z.discriminatedUnion("type", [
  z.object({
    /**
     * A session needs a model. Main makes it available (loading it into the bundled runtime if
     * needed, which can take minutes) and answers with `model-grant` or `model-refused` carrying
     * the same `requestId`.
     */
    type: z.literal("model-request"),
    requestId: z.string().min(1),
    /** Null asks for the default model. */
    modelId: z.string().min(1).nullable(),
  }),
]);
export type HostToMain = z.infer<typeof HostToMainSchema>;

/** Main → engine host. */
export const MainToHostSchema = z.discriminatedUnion("type", [
  z.object({
    /** A window's protocol connection; the message carries one end of a fresh channel. */
    type: z.literal("connect"),
  }),
  z.object({
    type: z.literal("model-grant"),
    requestId: z.string().min(1),
    grant: ModelGrantSchema,
  }),
  z.object({
    type: z.literal("model-refused"),
    requestId: z.string().min(1),
    /** A sentence for the person: "No model is installed yet. Download one in Settings → Models." */
    message: z.string(),
    /** True when asking again later may work (still downloading, the runtime restarting). */
    retryable: z.boolean(),
  }),
  z.object({
    /**
     * Something about the models changed (one loaded, unloaded or removed; the runtime
     * restarted; a server came or went). Grants held may be out of date: ask again before the
     * next request.
     */
    type: z.literal("models-changed"),
  }),
]);
export type MainToHost = z.infer<typeof MainToHostSchema>;
