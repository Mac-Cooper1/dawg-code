/**
 * Events: notifications from the engine to the client. The notification's method is the event
 * name and its params are the payload. Every payload carries `sessionId`, `seq` and `time`.
 *
 * Ordering rules a client can rely on are listed in this package's README.
 */
import { z } from "zod";
import {
  ContentPartSchema,
  EffortSchema,
  ErrorInfoSchema,
  ModelInfoSchema,
  PermissionModeSchema,
  PermissionRequestSchema,
  PermissionResponseSchema,
  PlanResponseSchema,
  PromptSchema,
  QuestionResponseSchema,
  QuestionSchema,
  SessionIdSchema,
  SessionStatusSchema,
  StopReasonSchema,
  TaskItemSchema,
  TimestampSchema,
  ToolDisplaySchema,
  ToolProgressSchema,
  UsageSchema,
} from "./common.ts";

const IdSchema = z.string().min(1);

/** Fields every event carries. */
export const EventBaseSchema = z.object({
  sessionId: SessionIdSchema,
  /** Starts at 1 for a session's first event and grows by one per event, across resumes. */
  seq: z.number().int().positive(),
  /** When the engine emitted the event. */
  time: TimestampSchema,
});
export type EventBase = z.infer<typeof EventBaseSchema>;

// ---------------------------------------------------------------------------------------------
// Requests waiting on the person. Shared by the events that raise them and session snapshots.
// ---------------------------------------------------------------------------------------------

export const PermissionAskSchema = z.object({
  turnId: IdSchema,
  request: PermissionRequestSchema,
});

export const QuestionAskSchema = z.object({
  turnId: IdSchema,
  requestId: IdSchema,
  toolCallId: IdSchema,
  questions: z.array(QuestionSchema).min(1),
});

export const PlanAskSchema = z.object({
  turnId: IdSchema,
  requestId: IdSchema,
  toolCallId: IdSchema,
  /** The plan, in Markdown. */
  plan: z.string(),
  /** Where the plan document was saved (absolute), when it was. */
  planPath: z.string().nullable(),
});

/** A permission, question or plan request that has not been answered yet. */
export const PendingRequestSchema = z.discriminatedUnion("kind", [
  PermissionAskSchema.extend({ kind: z.literal("permission") }),
  QuestionAskSchema.extend({ kind: z.literal("question") }),
  PlanAskSchema.extend({ kind: z.literal("plan") }),
]);
export type PendingRequest = z.infer<typeof PendingRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------------------------

export const SessionStatusEventSchema = EventBaseSchema.extend({
  status: SessionStatusSchema,
  /** What the session waits on when `status` is "waiting"; otherwise null. */
  waitingOn: z.enum(["permission", "question", "plan"]).nullable(),
  /** A short line for the sidebar, for example "Waiting for the model". */
  message: z.string().nullable(),
});

/** Added: the session's settings, sent whole whenever one of them changes. */
export const SessionUpdatedEventSchema = EventBaseSchema.extend({
  title: z.string().nullable(),
  mode: PermissionModeSchema,
  model: z.string().nullable(),
  modelInfo: ModelInfoSchema.nullable(),
  effort: EffortSchema.nullable(),
  archived: z.boolean(),
  additionalDirectories: z.array(z.string()),
  /**
   * Which fields changed, for example ["mode"]. Known values: title, mode, model, effort,
   * archived, additionalDirectories. Plain strings so a newer engine can add fields.
   */
  changed: z.array(z.string()),
});

/** Added: a turn began. Carries the person's message, so a transcript rebuilds from events. */
export const TurnStartedEventSchema = EventBaseSchema.extend({
  turnId: IdSchema,
  prompt: PromptSchema,
  /** Set when a slash command started the turn; `prompt` then holds the command as typed. */
  command: z.object({ name: z.string(), args: z.string() }).nullable(),
});

/** Added: a turn ended. The last event of the turn. */
export const TurnFinishedEventSchema = EventBaseSchema.extend({
  turnId: IdSchema,
  stopReason: StopReasonSchema,
  /** Text of the turn's last assistant message, if it had any. */
  finalText: z.string().nullable(),
  /** Set when `stopReason` is "error". */
  error: ErrorInfoSchema.nullable(),
  durationMs: z.number().nonnegative(),
});

export const MessageStartedEventSchema = EventBaseSchema.extend({
  turnId: IdSchema,
  messageId: IdSchema,
});

export const MessageDeltaEventSchema = EventBaseSchema.extend({
  turnId: IdSchema,
  messageId: IdSchema,
  /** Text to append to the message. */
  text: z.string(),
});

export const MessageFinishedEventSchema = EventBaseSchema.extend({
  turnId: IdSchema,
  messageId: IdSchema,
  /** The whole text of the message. Replaces whatever the deltas built. */
  text: z.string(),
  /** The whole reasoning of the message, or null when there was none. */
  reasoning: z.string().nullable(),
  /** Tool calls the message made, in the order the model emitted them. */
  toolCalls: z.array(z.object({ toolCallId: IdSchema, toolName: z.string() })),
});

export const ReasoningDeltaEventSchema = EventBaseSchema.extend({
  turnId: IdSchema,
  messageId: IdSchema,
  text: z.string(),
});

export const ToolStartedEventSchema = EventBaseSchema.extend({
  turnId: IdSchema,
  /** The assistant message that made the call. */
  messageId: IdSchema,
  toolCallId: IdSchema,
  toolName: z.string(),
  /** The arguments after parsing and repair. An empty object when they could not be repaired. */
  input: z.record(z.string(), z.unknown()),
});

export const ToolProgressEventSchema = EventBaseSchema.extend({
  turnId: IdSchema,
  toolCallId: IdSchema,
  progress: ToolProgressSchema,
});

export const ToolOutcomeSchema = z.enum([
  "success",
  /** The tool ran and reported a failure the model can act on. */
  "error",
  /** Permission was refused, by a rule, the mode or the person. */
  "denied",
  /** The arguments failed validation; the tool did not run. */
  "invalid",
  /** The turn was interrupted before the call finished. */
  "interrupted",
]);
export type ToolOutcome = z.infer<typeof ToolOutcomeSchema>;

export const ToolFinishedEventSchema = EventBaseSchema.extend({
  turnId: IdSchema,
  toolCallId: IdSchema,
  toolName: z.string(),
  outcome: ToolOutcomeSchema,
  /** What the model was given as the result. */
  content: z.array(ContentPartSchema),
  /** A structured view, such as the diff an edit made. */
  display: ToolDisplaySchema.nullable(),
  /** Null when the tool never ran. */
  durationMs: z.number().nonnegative().nullable(),
});

export const PermissionRequestedEventSchema = EventBaseSchema.extend(PermissionAskSchema.shape);

export const QuestionAskedEventSchema = EventBaseSchema.extend(QuestionAskSchema.shape);

export const PlanProposedEventSchema = EventBaseSchema.extend(PlanAskSchema.shape);

const ResolutionOutcomeSchema = z.enum([
  "answered",
  /** The turn ended (interrupt or error) before an answer came. */
  "cancelled",
]);

/** Added: a pending permission, question or plan request is no longer pending. */
export const RequestResolvedEventSchema = z.discriminatedUnion("kind", [
  EventBaseSchema.extend({
    kind: z.literal("permission"),
    turnId: IdSchema,
    requestId: IdSchema,
    outcome: ResolutionOutcomeSchema,
    /** The answer given; null when cancelled. */
    response: PermissionResponseSchema.nullable(),
  }),
  EventBaseSchema.extend({
    kind: z.literal("question"),
    turnId: IdSchema,
    requestId: IdSchema,
    outcome: ResolutionOutcomeSchema,
    response: QuestionResponseSchema.nullable(),
  }),
  EventBaseSchema.extend({
    kind: z.literal("plan"),
    turnId: IdSchema,
    requestId: IdSchema,
    outcome: ResolutionOutcomeSchema,
    response: PlanResponseSchema.nullable(),
  }),
]);

export const TasksUpdatedEventSchema = EventBaseSchema.extend({
  /** The whole task list. */
  tasks: z.array(TaskItemSchema),
});

export const UsageUpdatedEventSchema = EventBaseSchema.extend({
  usage: UsageSchema,
});

export const PromptProgressEventSchema = EventBaseSchema.extend({
  turnId: IdSchema,
  /** Prompt tokens in this request. */
  total: z.number().int().nonnegative(),
  /** Of those, tokens reused from the cache. */
  cached: z.number().int().nonnegative(),
  /** Of those, tokens read so far, including cached ones. Reaches `total` when reading is done. */
  processed: z.number().int().nonnegative(),
});

export const CompactionStartedEventSchema = EventBaseSchema.extend({
  compactionId: IdSchema,
  /** "auto" at the context threshold, "manual" from `/compact`. */
  trigger: z.enum(["auto", "manual"]),
  /** The turn it runs in, or null when it runs between turns. */
  turnId: IdSchema.nullable(),
  contextUsed: z.number().int().nonnegative(),
  contextWindow: z.number().int().nonnegative(),
  /** The focus given to `/compact`, if any. */
  focus: z.string().nullable(),
});

export const CompactionFinishedEventSchema = EventBaseSchema.extend({
  compactionId: IdSchema,
  outcome: z.enum(["completed", "failed", "interrupted"]),
  /** The summary that replaced the history. Null unless completed. */
  summary: z.string().nullable(),
  contextBefore: z.number().int().nonnegative(),
  /** Null unless completed. */
  contextAfter: z.number().int().nonnegative().nullable(),
  error: ErrorInfoSchema.nullable(),
});

export const ErrorEventSchema = EventBaseSchema.extend({
  /** The turn it happened in, or null. */
  turnId: IdSchema.nullable(),
  error: ErrorInfoSchema,
});

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

/** Every event, by name. The runtime source of truth for event payloads. */
export const events = {
  "session.status": SessionStatusEventSchema,
  "session.updated": SessionUpdatedEventSchema,
  "turn.started": TurnStartedEventSchema,
  "turn.finished": TurnFinishedEventSchema,
  "message.started": MessageStartedEventSchema,
  "message.delta": MessageDeltaEventSchema,
  "message.finished": MessageFinishedEventSchema,
  "reasoning.delta": ReasoningDeltaEventSchema,
  "tool.started": ToolStartedEventSchema,
  "tool.progress": ToolProgressEventSchema,
  "tool.finished": ToolFinishedEventSchema,
  "permission.requested": PermissionRequestedEventSchema,
  "question.asked": QuestionAskedEventSchema,
  "plan.proposed": PlanProposedEventSchema,
  "request.resolved": RequestResolvedEventSchema,
  "tasks.updated": TasksUpdatedEventSchema,
  "usage.updated": UsageUpdatedEventSchema,
  "prompt.progress": PromptProgressEventSchema,
  "compaction.started": CompactionStartedEventSchema,
  "compaction.finished": CompactionFinishedEventSchema,
  error: ErrorEventSchema,
} as const satisfies Record<string, z.ZodType>;

export type EventName = keyof typeof events;
export const EVENT_NAMES = Object.keys(events) as EventName[];

/** Event name to payload, as received (after parsing). */
export type EventMap = { [E in EventName]: z.output<(typeof events)[E]> };
/** Event name to payload, as an engine builds it before sending. */
export type EventInputMap = { [E in EventName]: z.input<(typeof events)[E]> };

export type EventPayload<E extends EventName> = EventMap[E];
export type EventPayloadInput<E extends EventName> = EventInputMap[E];

/** One event with its name: the shape a reducer switches on. */
export type EngineEvent = { [E in EventName]: { event: E; payload: EventMap[E] } }[EventName];
export type EngineEventInput = {
  [E in EventName]: { event: E; payload: EventInputMap[E] };
}[EventName];

export function isEventName(name: string): name is EventName {
  return Object.hasOwn(events, name);
}

export type EventParseResult =
  | { ok: true; event: EngineEvent }
  | { ok: false; reason: "unknown"; name: string }
  | { ok: false; reason: "invalid"; name: EventName; error: z.ZodError };

/**
 * Validates an event payload by name. Unknown names are reported, not thrown, so a client can
 * ignore events a newer engine added.
 */
export function parseEvent(name: string, payload: unknown): EventParseResult {
  if (!isEventName(name)) return { ok: false, reason: "unknown", name };
  const parsed = events[name].safeParse(payload);
  if (!parsed.success) return { ok: false, reason: "invalid", name, error: parsed.error };
  return { ok: true, event: { event: name, payload: parsed.data } as EngineEvent };
}

/**
 * A stored or replayed event: `{ event, payload }`. Parsing drops events whose names this version
 * does not know, and fails on known events with bad payloads.
 */
export const ReplayedEventsSchema = z
  .array(z.object({ event: z.string(), payload: z.unknown() }))
  .transform((items, ctx): EngineEvent[] => {
    const out: EngineEvent[] = [];
    items.forEach((item, index) => {
      const parsed = parseEvent(item.event, item.payload);
      if (parsed.ok) {
        out.push(parsed.event);
      } else if (parsed.reason === "invalid") {
        for (const issue of parsed.error.issues) {
          ctx.issues.push({
            code: "custom",
            message: issue.message,
            path: [index, "payload", ...issue.path],
            input: item.payload,
          });
        }
      }
    });
    return out;
  });
