import type { z } from "zod";

/** Parses `value` like the real bridge does, or throws "Invalid <what>: <issues>". */
export function validate<S extends z.ZodType>(
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
