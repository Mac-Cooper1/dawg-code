/**
 * What the model manager remembers between launches, in `<data root>/models.json`: installed
 * models with their file paths, model files added by hand, remote servers (their keys are in
 * the Keychain, see keys.ts), the default model, idle unload, and downloads to pick up again.
 *
 * The app owns this file alone. Writes are atomic and never replace a file that could not be
 * parsed (see json-file.ts), so a hand edit with a typo is reported, not lost.
 */
import path from "node:path";
import { z } from "zod";
import { IdleUnloadSchema } from "../../shared/bridge.ts";
import { createJsonFile, type Logger } from "../json-file.ts";
import { parseWithFieldDefaults } from "../validate.ts";

export const InstalledRecordSchema = z.object({
  /** The catalog entry's id. */
  id: z.string().min(1),
  /** "download": dawg fetched it into the Hugging Face cache. Otherwise another app's copy, used in place. */
  source: z.enum(["download", "huggingface", "lmstudio", "ollama"]),
  modelPath: z.string().min(1),
  projectorPath: z.string().min(1).optional(),
});
export type InstalledRecord = z.infer<typeof InstalledRecordSchema>;

export const ModelFileRecordSchema = z.object({
  /** "file:<sha256 of the path>". */
  id: z.string().min(1),
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});
export type ModelFileRecord = z.infer<typeof ModelFileRecordSchema>;

export const RemoteServerRecordSchema = z.object({
  /** "remote:<short hash of the URL>". */
  id: z.string().min(1),
  /** The OpenAI-compatible root that answered, without credentials. */
  url: z.string().min(1),
});
export type RemoteServerRecord = z.infer<typeof RemoteServerRecordSchema>;

export const PendingDownloadSchema = z.object({
  modelId: z.string().min(1),
  /** "queued" starts again at launch; "paused" waits for the person. */
  phase: z.enum(["queued", "paused"]),
});
export type PendingDownload = z.infer<typeof PendingDownloadSchema>;

export const ModelsFileSchema = z.object({
  installed: z.array(InstalledRecordSchema).default([]),
  files: z.array(ModelFileRecordSchema).default([]),
  servers: z.array(RemoteServerRecordSchema).default([]),
  defaultModelId: z.string().min(1).nullable().default(null),
  idleUnloadMinutes: IdleUnloadSchema.default(null),
  downloads: z.array(PendingDownloadSchema).default([]),
});
export type ModelsFile = z.infer<typeof ModelsFileSchema>;

export function modelsFilePath(dataRoot: string): string {
  return path.join(dataRoot, "models.json");
}

export interface ModelsStore {
  load(): Promise<ModelsFile>;
  save(value: ModelsFile): Promise<void>;
}

export function createModelsStore(file: string, log: Logger): ModelsStore {
  const json = createJsonFile(file, log);
  return {
    async load() {
      const read = await json.read();
      if (read.kind === "missing") return ModelsFileSchema.parse({});
      if (read.kind === "unreadable") {
        log(`Starting with no saved models: ${file} could not be read (${read.reason}).`);
        return ModelsFileSchema.parse({});
      }
      const { value, invalidFields } = parseWithFieldDefaults(ModelsFileSchema, read.value);
      if (invalidFields.length > 0) {
        log(`Ignoring invalid fields in ${file}: ${invalidFields.join(", ")}`);
      }
      return value;
    },
    async save(value) {
      const validated = ModelsFileSchema.parse(value);
      await json.update((current) => ({ ...current, ...validated }));
    },
  };
}
