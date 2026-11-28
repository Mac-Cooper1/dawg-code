import { z } from "zod";
import type { CatalogEntry } from "../types.ts";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256");
const commitHash = z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-character commit hash");
const repoId = z
  .string()
  .regex(/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/, "must look like org/name");
const repoFilePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "must be a relative path inside the repo",
  );
const positiveInt = z.number().int().positive();

export const ChipClassSchema = z.enum(["base", "pro", "max", "ultra", "intel"]);
export const CatalogRoleSchema = z.enum(["main", "helper"]);

/**
 * The largest default context a helper may have. A helper runs beside the main model, so its
 * cache comes out of the same memory; its jobs (a title, one page) need no more than this.
 */
export const HELPER_MAX_CONTEXT = 65_536;

export const CatalogFileSchema = z.strictObject({
  file: repoFilePath,
  sha256,
  sizeBytes: positiveInt,
});

export const CatalogEntrySchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, "lowercase letters, digits, '.' and '-'"),
    role: CatalogRoleSchema.optional(),
    displayName: z.string().min(1),
    licence: z.strictObject({ spdx: z.string().min(1), url: z.url({ protocol: /^https$/ }) }),
    source: z.strictObject({
      repo: repoId,
      revision: commitHash,
      file: repoFilePath,
      sha256,
      sizeBytes: positiveInt,
    }),
    projector: CatalogFileSchema.optional(),
    minMemoryBytes: positiveInt,
    chipClasses: z
      .array(ChipClassSchema)
      .min(1)
      .refine((classes) => !classes.includes("intel"), "Intel is not an inference target")
      .optional(),
    context: z.strictObject({ default: positiveInt, max: positiveInt }),
    capabilities: z.strictObject({
      tools: z.boolean(),
      vision: z.boolean(),
      reasoning: z.boolean(),
    }),
    profile: z.string().min(1),
    rank: z.number().int(),
  })
  .check((ctx) => {
    const entry = ctx.value;
    if (entry.context.default > entry.context.max) {
      ctx.issues.push({
        code: "custom",
        input: entry.context,
        path: ["context", "default"],
        message: "default context must not exceed max",
      });
    }
    if (entry.capabilities.vision !== (entry.projector !== undefined)) {
      ctx.issues.push({
        code: "custom",
        input: entry.projector,
        path: ["projector"],
        message: "a vision model needs a projector file, and only a vision model has one",
      });
    }
    if (entry.projector && entry.projector.file === entry.source.file) {
      ctx.issues.push({
        code: "custom",
        input: entry.projector,
        path: ["projector", "file"],
        message: "projector must be a different file from the model",
      });
    }
    if (entry.role === "helper") {
      // Side requests are text only and run beside the main model: no projector, a small cache.
      if (entry.capabilities.vision) {
        ctx.issues.push({
          code: "custom",
          input: entry.capabilities,
          path: ["capabilities", "vision"],
          message: "a helper answers text-only side requests and has no projector",
        });
      }
      if (entry.context.default > HELPER_MAX_CONTEXT) {
        ctx.issues.push({
          code: "custom",
          input: entry.context,
          path: ["context", "default"],
          message: `a helper's default context must not exceed ${HELPER_MAX_CONTEXT}`,
        });
      }
    }
  });

export const CatalogSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    /** Increases with every published change; the highest valid version wins. */
    version: z.number().int().nonnegative(),
    entries: z.array(CatalogEntrySchema),
  })
  .check((ctx) => {
    const seen = new Set<string>();
    ctx.value.entries.forEach((entry, index) => {
      if (seen.has(entry.id)) {
        ctx.issues.push({
          code: "custom",
          input: entry.id,
          path: ["entries", index, "id"],
          message: `duplicate id ${entry.id}`,
        });
      }
      seen.add(entry.id);
    });
  });

export type Catalog = z.infer<typeof CatalogSchema>;

// Compile-time check: the schema and the shared CatalogEntry interface describe the same shape.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const schemaMatchesInterface: MutuallyAssignable<
  z.infer<typeof CatalogEntrySchema>,
  CatalogEntry
> = true;
void schemaMatchesInterface;

/** Formats zod issues as short `path: message` lines. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
