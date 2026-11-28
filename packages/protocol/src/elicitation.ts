/**
 * MCP elicitation (Phase 4 spec, MCP: "a server's request for input is shown as a form"). While
 * one of a session's calls to an MCP server is in progress, the server may ask the person for
 * input (the MCP specification's `elicitation/create`):
 *
 * - form mode: a flat form of strings, numbers, booleans and choices, answered in the client;
 * - URL mode: a page the person opens in their browser, so what they type there never passes
 *   through dawg (sign-in, payment, an API key).
 *
 * The engine raises it as a pending request of the session whose call caused it, like a question
 * (`elicitation.requested`, `elicitation.respond`, then `request.resolved` with kind
 * "elicitation"). The server's message, titles and descriptions are untrusted text: clients show
 * them as plain text, never as Markdown or links, and open a URL only when the person asks.
 *
 * The form is MCP's restricted schema turned into a list of fields, so a client draws it without
 * reading JSON Schema. Answers are checked against it again by the engine.
 */
import { z } from "zod";
import { SessionIdSchema, SubagentLabelSchema, TimestampSchema } from "./common.ts";

const IdSchema = z.string().min(1);

/** The string formats MCP's restricted schema allows. */
export const ElicitationStringFormatSchema = z.enum(["email", "uri", "date", "date-time"]);
export type ElicitationStringFormat = z.infer<typeof ElicitationStringFormatSchema>;

/** One choice of a select field. */
export const ElicitationOptionSchema = z.object({
  /** What the content carries when it is picked. */
  value: z.string(),
  /** The server's label for it, or null to show the value. */
  title: z.string().nullable(),
});
export type ElicitationOption = z.infer<typeof ElicitationOptionSchema>;

const FieldBase = {
  /** The property's name in the content. */
  name: z.string().min(1),
  /** The server's label, or null to show the name. */
  title: z.string().nullable(),
  description: z.string().nullable(),
  /** The server listed it as required. */
  required: z.boolean(),
};
const Count = z.number().int().nonnegative().nullable();

export const ElicitationFieldSchema = z.discriminatedUnion("type", [
  z.object({
    ...FieldBase,
    type: z.literal("string"),
    format: ElicitationStringFormatSchema.nullable(),
    minLength: Count,
    maxLength: Count,
    default: z.string().nullable(),
  }),
  z.object({
    ...FieldBase,
    /** "integer" takes whole numbers only. */
    type: z.enum(["number", "integer"]),
    minimum: z.number().nullable(),
    maximum: z.number().nullable(),
    default: z.number().nullable(),
  }),
  z.object({
    ...FieldBase,
    type: z.literal("boolean"),
    default: z.boolean().nullable(),
  }),
  z.object({
    ...FieldBase,
    /** One of the options. */
    type: z.literal("select"),
    options: z.array(ElicitationOptionSchema).min(1),
    default: z.string().nullable(),
  }),
  z.object({
    ...FieldBase,
    /** Any number of the options, within `minItems` and `maxItems`. */
    type: z.literal("multiselect"),
    options: z.array(ElicitationOptionSchema).min(1),
    minItems: Count,
    maxItems: Count,
    default: z.array(z.string()).nullable(),
  }),
]);
export type ElicitationField = z.infer<typeof ElicitationFieldSchema>;

/** A form's answers, by field name: a string, a number, a boolean, or a multiselect's values. */
export const ElicitationContentSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
);
export type ElicitationContent = z.infer<typeof ElicitationContentSchema>;

/**
 * - accept: the person submitted the form (with `content`), or agreed to open the page;
 * - decline: they said no;
 * - cancel: they dismissed it without choosing.
 */
export const ElicitationActionSchema = z.enum(["accept", "decline", "cancel"]);
export type ElicitationAction = z.infer<typeof ElicitationActionSchema>;

/** The answer, as `request.resolved` carries it. */
export const ElicitationResponseSchema = z.object({
  action: ElicitationActionSchema,
  /** The form's answers when accepted in form mode; null otherwise. */
  content: ElicitationContentSchema.nullable().default(null),
});
export type ElicitationResponse = z.infer<typeof ElicitationResponseSchema>;

/** A server's request for input, waiting on the person. */
export const ElicitationAskSchema = z.object({
  turnId: IdSchema,
  requestId: IdSchema,
  /** The call to the server it came during, or null when the session had several open. */
  toolCallId: IdSchema.nullable(),
  /** The MCP server's name in the configuration, which the card is labelled with. */
  server: z.string().min(1),
  /** Why the server asks, in its own words. Untrusted: shown as plain text. */
  message: z.string(),
  mode: z.enum(["form", "url"]),
  /** The form, in the server's order. Empty in URL mode. */
  fields: z.array(ElicitationFieldSchema),
  /** The page to open, in URL mode; null in form mode. Opened only when the person asks. */
  url: z.string().nullable(),
  /**
   * Set when a subagent's call caused it: it is raised in the parent session, labelled with the
   * agent, as the agent's permission requests are. `toolCallId` is then a call in the agent's
   * session and `turnId` may be one of its turns.
   */
  agent: SubagentLabelSchema.optional(),
});
export type ElicitationAsk = z.infer<typeof ElicitationAskSchema>;

/**
 * Added: an MCP server asked the person for input during one of the session's calls. Followed by
 * exactly one `request.resolved` with kind "elicitation" and the same `requestId`. The common
 * fields are written out here rather than taken from events.ts, which imports this file.
 */
export const ElicitationRequestedEventSchema = z.object({
  sessionId: SessionIdSchema,
  seq: z.number().int().positive(),
  time: TimestampSchema,
  ...ElicitationAskSchema.shape,
});

/**
 * Answers a server's request for input. `content` goes with "accept" in form mode, and must
 * match the fields (InvalidParams otherwise, and the request stays pending).
 */
export const ElicitationRespondParamsSchema = z.object({
  sessionId: SessionIdSchema,
  requestId: IdSchema,
  action: ElicitationActionSchema,
  content: ElicitationContentSchema.optional(),
});

// ---------------------------------------------------------------------------------------------
// Checking an answer against the form: one place, so the engine, the app and the command line
// agree on what is valid and say it the same way.
// ---------------------------------------------------------------------------------------------

/** Why one field's answer is not valid, for the person. `field` is null for the form as a whole. */
export interface ElicitationIssue {
  field: string | null;
  message: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})$/;

function validDate(text: string): boolean {
  const match = DATE.exec(text);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function validUri(text: string): boolean {
  try {
    return new URL(text).protocol.length > 1;
  } catch {
    return false;
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What is wrong with one field's value, or null when it is fine. */
export function elicitationFieldIssue(field: ElicitationField, value: unknown): string | null {
  switch (field.type) {
    case "string": {
      if (typeof value !== "string") return "Enter text.";
      const length = [...value].length;
      if (field.minLength !== null && length < field.minLength) {
        return `Use at least ${plural(field.minLength, "character", "characters")}.`;
      }
      if (field.maxLength !== null && length > field.maxLength) {
        return `Use at most ${plural(field.maxLength, "character", "characters")}.`;
      }
      if (field.format === "email" && !EMAIL.test(value)) return "Enter an email address.";
      if (field.format === "uri" && !validUri(value))
        return "Enter a full address, such as https://example.com.";
      if (field.format === "date" && !validDate(value)) return "Enter a date as YYYY-MM-DD.";
      if (
        field.format === "date-time" &&
        (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))
      ) {
        return "Enter a date and time, such as 2026-11-27T09:30:00Z.";
      }
      return null;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "Enter a number.";
      if (field.type === "integer" && !Number.isInteger(value)) return "Enter a whole number.";
      const { minimum: min, maximum: max } = field;
      if ((min !== null && value < min) || (max !== null && value > max)) {
        if (min !== null && max !== null) return `Enter a number from ${min} to ${max}.`;
        return min !== null ? `Enter ${min} or more.` : `Enter ${max} or less.`;
      }
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : "Choose yes or no.";
    case "select":
      return typeof value === "string" && field.options.some((o) => o.value === value)
        ? null
        : "Pick one of the choices.";
    case "multiselect": {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        return "Pick from the choices.";
      }
      if (value.some((v) => !field.options.some((o) => o.value === v))) {
        return "Pick only from the choices.";
      }
      if (new Set(value).size !== value.length) return "Pick each choice once.";
      if (field.minItems !== null && value.length < field.minItems) {
        return `Pick at least ${field.minItems}.`;
      }
      if (field.maxItems !== null && value.length > field.maxItems) {
        return `Pick at most ${field.maxItems}.`;
      }
      return null;
    }
  }
}

/**
 * Every problem with an answer to a form: required fields left out, values of the wrong kind or
 * outside their limits, and names the form does not have. Empty when the answer is valid.
 */
export function elicitationIssues(
  fields: readonly ElicitationField[],
  content: Readonly<Record<string, unknown>>,
): ElicitationIssue[] {
  const issues: ElicitationIssue[] = [];
  for (const field of fields) {
    const value = content[field.name];
    if (value === undefined) {
      if (field.required) issues.push({ field: field.name, message: "This is required." });
      continue;
    }
    const message = elicitationFieldIssue(field, value);
    if (message !== null) issues.push({ field: field.name, message });
  }
  for (const name of Object.keys(content)) {
    if (!fields.some((f) => f.name === name)) {
      issues.push({ field: null, message: `The form has no field named ${name}.` });
    }
  }
  return issues;
}
