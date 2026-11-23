/**
 * The recorded-session format the mock engine replays. Contract between the mock engine, its
 * fixtures and the reducer tests.
 *
 * A **recording** is a list of protocol events in exactly the shape `dawg -p --output-format
 * stream-json` prints: one `{"event": name, "payload": {...}}` object per line (JSONL). A real
 * capture from the command-line tool can therefore be dropped in as a fixture.
 *
 * A **scenario** is one session: its settings, the recordings that make up its history, and the
 * recordings that continue it after a decision (permission, question, plan) or a new prompt.
 *
 * Fixture layout: `src/mock-engine/fixtures/<scenario id>/scenario.json` plus the `.jsonl`
 * recordings it names, in the same folder.
 */
import {
  EffortSchema,
  type EngineEvent,
  PermissionModeSchema,
  type PermissionResponse,
  type PlanResponse,
  parseEvent,
  type QuestionResponse,
} from "@dawg/protocol";
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

/** A recording file name, relative to the scenario's folder, for example "stored.jsonl". */
const RecordingNameSchema = z.string().regex(/^[\w.-]+\.jsonl$/);

export const ScenarioSchema = z.strictObject({
  /** The session id. Unique across fixtures. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  session: z.strictObject({
    /** Null until a title is generated. */
    title: z.string().nullable(),
    /** Working directory. A leading "~/" expands to the engine's home directory. */
    cwd: z.string().min(1),
    /** The project the session belongs to; differs from `cwd` for a worktree session. */
    projectDir: z.string().min(1),
    mode: PermissionModeSchema,
    /** A model id from `shared/mock-models.ts`, or null. */
    model: z.string().nullable(),
    effort: EffortSchema.nullable(),
  }),
  /**
   * How long before the engine started the stored part ended, in milliseconds. Sets the session's
   * `createdAt` / `lastActivityAt` and rebases recorded times, so the sidebar reads "3m" or
   * "Yesterday".
   */
  storedEndedAgoMs: z.number().int().nonnegative(),
  /**
   * Events already in the transcript when the engine starts, served by `session.replay`.
   * It may end inside a turn: at a decision point (the session starts "waiting"), or anywhere
   * else when `live` continues it.
   */
  stored: RecordingNameSchema.nullable(),
  /** Plays in real time from engine start (or once `queuedBehind` frees the model). */
  live: RecordingNameSchema.nullable(),
  /**
   * Another scenario id. Until that session's running turn ends, this session reports
   * `session.status` "working" with the message "Queued: waits for the model", and `live`
   * waits.
   */
  queuedBehind: z.string().nullable(),
  /**
   * Continuations after a decision: requestId → match key → recording. Each continuation starts
   * with its recorded `request.resolved`; the engine replaces that event's `response` with the
   * answer actually given. See `matchKeys` for the keys.
   */
  branches: z.record(z.string(), z.record(z.string(), RecordingNameSchema)),
  /**
   * Turns played in order, one per `session.prompt`, each starting with its `turn.started`
   * (whose `prompt` is replaced by the prompt actually sent). After the last one, the engine
   * answers prompts with a generic reply.
   */
  turns: z.array(RecordingNameSchema),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

/** A scenario with its recordings parsed. */
export interface LoadedScenario {
  scenario: Scenario;
  /** Recording name → events, in file order. */
  recordings: Record<string, EngineEvent[]>;
}

// ---------------------------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------------------------

export class RecordingError extends Error {
  override readonly name = "RecordingError";
}

/**
 * Parses a JSONL recording. Blank lines are skipped. Every line must be a known event whose
 * payload passes its schema; anything else throws a `RecordingError` naming the file and line.
 */
export function parseRecording(text: string, fileName = "recording"): EngineEvent[] {
  const out: EngineEvent[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new RecordingError(`${fileName}:${index + 1}: not JSON (${String(error)})`);
    }
    const item = z.object({ event: z.string(), payload: z.unknown() }).safeParse(value);
    if (!item.success) {
      throw new RecordingError(`${fileName}:${index + 1}: expected {"event", "payload"}`);
    }
    const parsed = parseEvent(item.data.event, item.data.payload);
    if (!parsed.ok) {
      const why =
        parsed.reason === "unknown"
          ? `unknown event "${parsed.name}"`
          : parsed.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ");
      throw new RecordingError(`${fileName}:${index + 1}: ${why}`);
    }
    out.push(parsed.event);
  });
  return out;
}

/** Serialises events as a JSONL recording (one event per line, trailing newline). */
export function formatRecording(events: readonly EngineEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "");
}

// ---------------------------------------------------------------------------------------------
// Branch match keys
// ---------------------------------------------------------------------------------------------

export type DecisionResponse =
  | { kind: "permission"; response: PermissionResponse }
  | { kind: "question"; response: QuestionResponse }
  | { kind: "plan"; response: PlanResponse };

/**
 * The keys a response matches, most specific first; the first key present in the request's
 * branch table wins, and "*" matches anything.
 *
 * | Decision   | Keys                                                                 |
 * | ---------- | -------------------------------------------------------------------- |
 * | permission | `allow:always` or `allow:once`, then `allow`; or `deny`               |
 * | question   | `answer:<label of the first selected option>`, then `answer`; or `dismiss` |
 * | plan       | `approve:<mode>` (when a mode is given), then `approve`; or `reject`  |
 */
export function matchKeys(decision: DecisionResponse): string[] {
  const keys: string[] = [];
  switch (decision.kind) {
    case "permission": {
      const { response } = decision;
      if (response.behavior === "allow") keys.push(`allow:${response.scope}`, "allow");
      else keys.push("deny");
      break;
    }
    case "question": {
      const { response } = decision;
      if (response.outcome === "answered") {
        const label = response.answers.find((answer) => answer.selected.length > 0)?.selected[0];
        if (label !== undefined) keys.push(`answer:${label}`);
        keys.push("answer");
      } else {
        keys.push("dismiss");
      }
      break;
    }
    case "plan": {
      const { response } = decision;
      if (response.decision === "approve") {
        if (response.mode !== undefined) keys.push(`approve:${response.mode}`);
        keys.push("approve");
      } else {
        keys.push("reject");
      }
      break;
    }
  }
  keys.push("*");
  return keys;
}

/** Picks the continuation for a decision, or null when the scenario has none. */
export function pickBranch(
  table: Record<string, string> | undefined,
  decision: DecisionResponse,
): string | null {
  if (!table) return null;
  for (const key of matchKeys(decision)) {
    const name = table[key];
    if (name !== undefined) return name;
  }
  return null;
}
