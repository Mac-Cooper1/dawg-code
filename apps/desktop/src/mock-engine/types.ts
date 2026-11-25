/** Type helpers shared by the engine and the recording builder. */
import type { EngineEvent, EventInputMap, EventMap, EventName } from "@dawg/protocol";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * An event's payload without the fields every event carries (`sessionId`, `seq`, `time`). Fields
 * with defaults are required too: the engine writes every field, as the real engine does.
 */
export type Fields<E extends EventName> = DistributiveOmit<
  EventMap[E],
  "sessionId" | "seq" | "time"
>;

/** As `Fields`, for events that go through the protocol's parser, which fills in defaults. */
export type InputFields<E extends EventName> = DistributiveOmit<
  EventInputMap[E],
  "sessionId" | "seq" | "time"
>;

/** A received event of one kind. */
export type EventOf<E extends EventName> = Extract<EngineEvent, { event: E }>;
