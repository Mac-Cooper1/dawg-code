/**
 * The session file format: one JSON object per line, one line per record.
 *
 * Every record carries `type`, the format version `v`, a sequence number `seq` (0 for `meta`,
 * then +1 per record) and an ISO `time`. Records that hold conversation content store the
 * contract's `Message` objects as they were given, so replaying a file gives back the same
 * history byte for byte.
 *
 * The message schemas are strict: a message with a field the contract does not define is
 * refused at write time, because a field we do not know about is a field we cannot promise to
 * read back the same way.
 */
import {
  ContentPartSchema,
  EffortSchema,
  PermissionModeSchema,
  PROTOCOL_VERSION,
  TaskItemSchema,
  ToolDisplaySchema,
} from "@dawg/protocol";
import { z } from "zod";
import type {
  AssistantMessage,
  Message,
  SystemMessage,
  ToolResultMessage,
  UserMessage,
} from "../contracts/index.ts";

/** Bumped when a reader of the previous version could misread a file. */
export const SESSION_FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Messages (mirrors packages/engine/src/contracts/messages.ts)
// ---------------------------------------------------------------------------------------------

export const SystemMessageSchema = z.strictObject({
  role: z.literal("system"),
  content: z.string(),
});

export const UserMessageSchema = z.strictObject({
  role: z.literal("user"),
  content: z.array(ContentPartSchema),
  kind: z.enum(["prompt", "note"]),
});

export const ToolCallSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
  rawArguments: z.string().optional(),
});

export const AssistantMessageSchema = z.strictObject({
  role: z.literal("assistant"),
  content: z.string(),
  reasoning: z.string().optional(),
  toolCalls: z.array(ToolCallSchema),
});

export const ToolResultMessageSchema = z.strictObject({
  role: z.literal("tool"),
  toolCallId: z.string(),
  toolName: z.string(),
  content: z.array(ContentPartSchema),
  isError: z.boolean(),
});

export const MessageSchema = z.discriminatedUnion("role", [
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolResultMessageSchema,
]);

// Compile-time check that the schemas and the contract agree in both directions.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _messagesAgree: [
  Same<z.infer<typeof SystemMessageSchema>, SystemMessage>,
  Same<z.infer<typeof UserMessageSchema>, UserMessage>,
  Same<z.infer<typeof AssistantMessageSchema>, AssistantMessage>,
  Same<z.infer<typeof ToolResultMessageSchema>, ToolResultMessage>,
  Same<z.infer<typeof MessageSchema>, Message>,
] = [true, true, true, true, true];
void _messagesAgree;

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

const envelope = {
  v: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
  time: z.iso.datetime({ offset: true }),
};

export const ForkPointSchema = z.object({
  sessionId: z.string(),
  /** The last record copied from the parent. */
  seq: z.number().int().nonnegative(),
});
export type ForkPoint = z.infer<typeof ForkPointSchema>;

export const MetaRecordSchema = z.object({
  type: z.literal("meta"),
  ...envelope,
  seq: z.literal(0),
  sessionId: z.string(),
  /** The session's primary working directory (absolute). */
  cwd: z.string(),
  /** The title at creation. Later titles are `state` records. */
  title: z.string().nullable(),
  protocolVersion: z.number().int().positive(),
  forkedFrom: ForkPointSchema.nullable(),
});

/** A prompt the person sent. */
export const UserRecordSchema = z.object({
  type: z.literal("user"),
  ...envelope,
  message: UserMessageSchema.extend({ kind: z.literal("prompt") }),
});

/**
 * A message the engine added to the model's view: a system note in the user role, or a system
 * message such as the session context written at the start.
 */
export const NoteRecordSchema = z.object({
  type: z.literal("note"),
  ...envelope,
  message: z.discriminatedUnion("role", [
    UserMessageSchema.extend({ kind: z.literal("note") }),
    SystemMessageSchema,
  ]),
});

export const ModelUsageSchema = z.object({
  promptTokens: z.number().nullable(),
  completionTokens: z.number().nullable(),
  cachedTokens: z.number().nullable(),
  promptTokensPerSecond: z.number().nullable(),
  completionTokensPerSecond: z.number().nullable(),
  promptMs: z.number().nullable(),
  completionMs: z.number().nullable(),
});

/** Facts about the request that produced a reply. Kept for display and accounting only. */
export const ReplyInfoSchema = z.object({
  model: z.string().nullable().optional(),
  finishReason: z.enum(["stop", "tool_calls", "length", "content_filter", "unknown"]).optional(),
  usage: ModelUsageSchema.optional(),
});
export type ReplyInfo = z.infer<typeof ReplyInfoSchema>;

export const AssistantRecordSchema = z.object({
  type: z.literal("assistant"),
  ...envelope,
  message: AssistantMessageSchema,
  info: ReplyInfoSchema.optional(),
});

export const ToolResultRecordSchema = z.object({
  type: z.literal("tool_result"),
  ...envelope,
  message: ToolResultMessageSchema,
  /** The structured view clients show, such as an edit's diff. Not sent to the model. */
  display: ToolDisplaySchema.optional(),
  durationMs: z.number().nonnegative().optional(),
});

export const StateChangesSchema = z
  .object({
    mode: PermissionModeSchema,
    /** Model id; null returns to the configured default. */
    model: z.string().nullable(),
    /** Effort level; null returns to the model's default. */
    effort: EffortSchema.nullable(),
    title: z.string().nullable(),
    archived: z.boolean(),
    /** The whole task list; each change replaces it. */
    tasks: z.array(TaskItemSchema),
    /** Directories added with /add-dir (absolute); each change replaces the list. */
    additionalDirectories: z.array(z.string()),
  })
  .partial()
  .refine((changes) => Object.keys(changes).length > 0, "a state record must change something");
export type StateChanges = z.infer<typeof StateChangesSchema>;

export const StateRecordSchema = z.object({
  type: z.literal("state"),
  ...envelope,
  changes: StateChangesSchema,
});

/**
 * A compaction boundary. `messages` is the whole of the model's view after compaction (the
 * summary message, the task list, the kept turns, fresh file copies), so it can be restored
 * exactly. Records before it stay in the file; only the model's view changes.
 */
export const CompactRecordSchema = z.object({
  type: z.literal("compact"),
  ...envelope,
  trigger: z.enum(["auto", "manual"]),
  /** The text given with `/compact [focus]`. */
  focus: z.string().optional(),
  /** The summary as the model wrote it, for display and export. */
  summary: z.string(),
  messages: z.array(MessageSchema),
  tokensBefore: z.number().int().nonnegative().nullable().optional(),
  tokensAfter: z.number().int().nonnegative().nullable().optional(),
});

export const SessionRecordSchema = z.discriminatedUnion("type", [
  MetaRecordSchema,
  UserRecordSchema,
  NoteRecordSchema,
  AssistantRecordSchema,
  ToolResultRecordSchema,
  StateRecordSchema,
  CompactRecordSchema,
]);

export type MetaRecord = z.infer<typeof MetaRecordSchema>;
export type UserRecord = z.infer<typeof UserRecordSchema>;
export type NoteRecord = z.infer<typeof NoteRecordSchema>;
export type AssistantRecord = z.infer<typeof AssistantRecordSchema>;
export type ToolResultRecord = z.infer<typeof ToolResultRecordSchema>;
export type StateRecord = z.infer<typeof StateRecordSchema>;
export type CompactRecord = z.infer<typeof CompactRecordSchema>;
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
export type SessionRecordType = SessionRecord["type"];

type Envelope = "v" | "seq" | "time";
type WithoutEnvelope<R> = R extends unknown ? Omit<R, Envelope> : never;
/** A record as the caller hands it to the writer, which fills in `v`, `seq` and `time`. */
export type RecordInput = WithoutEnvelope<Exclude<SessionRecord, MetaRecord>>;

/** Records whose `message` belongs in the model's view. */
export type MessageRecord = UserRecord | NoteRecord | AssistantRecord | ToolResultRecord;

export function isMessageRecord(record: SessionRecord): record is MessageRecord {
  return (
    record.type === "user" ||
    record.type === "note" ||
    record.type === "assistant" ||
    record.type === "tool_result"
  );
}

/** Which record a message is stored in. */
export function recordTypeForMessage(message: Message): MessageRecord["type"] {
  switch (message.role) {
    case "user":
      return message.kind === "prompt" ? "user" : "note";
    case "system":
      return "note";
    case "assistant":
      return "assistant";
    case "tool":
      return "tool_result";
  }
}

/** The protocol version written into new sessions' `meta` records. */
export const CURRENT_PROTOCOL_VERSION: number = PROTOCOL_VERSION;
