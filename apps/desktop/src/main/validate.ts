import type { z } from "zod";

/**
 * Parses IPC input against its schema, throwing a plain Error with a short readable message.
 * Main validates everything again even though the preload already did: a compromised renderer
 * can send anything over IPC.
 */
export function validateInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
  throw new Error(`Invalid ${what}: ${issues}`);
}

/**
 * Parses an object field by field, so one bad value in a hand-edited file costs only that field:
 * every field that fails falls back to its default. The schema's fields must all have defaults.
 */
export function parseWithFieldDefaults<S extends z.ZodObject>(
  schema: S,
  raw: unknown,
): { value: z.output<S>; invalidFields: string[] } {
  const whole = schema.safeParse(raw ?? {});
  if (whole.success) return { value: whole.data, invalidFields: [] };
  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const fields: Record<string, unknown> = {};
  const invalidFields: string[] = [];
  for (const [key, field] of Object.entries(schema.shape) as [string, z.ZodType][]) {
    const parsed = field.safeParse(input[key]);
    if (parsed.success) {
      fields[key] = parsed.data;
    } else {
      invalidFields.push(key);
      fields[key] = field.parse(undefined);
    }
  }
  return { value: schema.parse(fields), invalidFields };
}
