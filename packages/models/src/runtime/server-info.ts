import { z } from "zod";
import type { CatalogEntry, Endpoint, ModelCapabilities } from "../types.ts";

/**
 * Readback of a running llama-server (`GET /props` and `GET /v1/models`), as observed on build
 * b12359. Schemas are lenient: unknown fields are kept, and only what the app relies on is
 * required.
 */

const templateCapsSchema = z
  .object({
    supports_tools: z.boolean().optional(),
    supports_tool_calls: z.boolean().optional(),
    supports_parallel_tool_calls: z.boolean().optional(),
    supports_reasoning_effort: z.boolean().optional(),
    supports_preserve_reasoning: z.boolean().optional(),
    supports_system_role: z.boolean().optional(),
    reasoning_effort_levels: z.array(z.string()).optional(),
  })
  .loose();

export const propsSchema = z
  .object({
    default_generation_settings: z.object({ n_ctx: z.number().int().positive() }).loose(),
    total_slots: z.number().int().positive(),
    model_path: z.string().optional(),
    model_alias: z.string().optional(),
    chat_template: z.string().optional(),
    chat_template_caps: templateCapsSchema.optional(),
    modalities: z
      .object({ vision: z.boolean().optional(), audio: z.boolean().optional() })
      .loose()
      .optional(),
    build_info: z.string().optional(),
    is_sleeping: z.boolean().optional(),
  })
  .loose();
export type LlamaProps = z.infer<typeof propsSchema>;

export const llamaModelsSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            id: z.string(),
            meta: z
              .object({
                n_ctx: z.number().optional(),
                n_ctx_train: z.number().optional(),
                n_params: z.number().optional(),
                size: z.number().optional(),
              })
              .loose()
              .nullable()
              .optional(),
          })
          .loose(),
      )
      .min(1),
  })
  .loose();
export type LlamaModels = z.infer<typeof llamaModelsSchema>;

export interface ServerInfo {
  /** The id requests must use (the `--alias`, else the model path). */
  modelId: string;
  /** Context available to one slot: what a single conversation can use. */
  contextWindow: number;
  /** The model's training context, when reported. */
  trainedContext?: number;
  totalSlots: number;
  chatTemplate: string;
  templateCaps: z.infer<typeof templateCapsSchema>;
  /** A projector is loaded and images are accepted. */
  vision: boolean;
  /** For example "b12359-b1b770d90". */
  buildInfo: string;
  isSleeping: boolean;
}

export function parseServerInfo(props: unknown, models: unknown): ServerInfo {
  const p = propsSchema.parse(props);
  const m = llamaModelsSchema.parse(models);
  const model = m.data[0];
  if (!model) throw new Error("no model reported");
  return {
    modelId: model.id,
    contextWindow: p.default_generation_settings.n_ctx,
    trainedContext: model.meta?.n_ctx_train,
    totalSlots: p.total_slots,
    chatTemplate: p.chat_template ?? "",
    templateCaps: p.chat_template_caps ?? {},
    vision: p.modalities?.vision === true,
    buildInfo: p.build_info ?? "",
    isSleeping: p.is_sleeping === true,
  };
}

const REASONING_TEMPLATE_HINTS = /enable_thinking|reasoning_content|<think>/;

/**
 * Capabilities as the server can actually deliver them, refined by the catalog entry when the
 * model came from the catalog:
 * - tools: the template must support tool calls; the catalog can only turn this off.
 * - vision: a projector must be loaded; the catalog can only turn this off.
 * - reasoning: the catalog decides when present; otherwise inferred from the template.
 */
export function deriveCapabilities(info: ServerInfo, catalog?: CatalogEntry): ModelCapabilities {
  const caps = info.templateCaps;
  const templateTools = caps.supports_tools === true || caps.supports_tool_calls === true;
  const templateReasoning =
    caps.supports_reasoning_effort === true ||
    caps.supports_preserve_reasoning === true ||
    (caps.reasoning_effort_levels?.length ?? 0) > 0 ||
    REASONING_TEMPLATE_HINTS.test(info.chatTemplate);
  return {
    tools: templateTools && (catalog?.capabilities.tools ?? true),
    vision: info.vision && (catalog?.capabilities.vision ?? true),
    reasoning: catalog?.capabilities.reasoning ?? templateReasoning,
  };
}

export function bundledEndpoint(
  port: number,
  apiKey: string,
  info: ServerInfo,
  catalog?: CatalogEntry,
): Endpoint {
  return {
    kind: "bundled",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey,
    model: info.modelId,
    contextWindow: info.contextWindow,
    capabilities: { ...deriveCapabilities(info, catalog), cacheControl: true },
    template: {
      parallelToolCalls: info.templateCaps.supports_parallel_tool_calls === true,
      reasoningEffortLevels: info.templateCaps.reasoning_effort_levels ?? [],
    },
  };
}
