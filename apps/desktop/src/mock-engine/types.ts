/** Type helpers shared by the engine and the recording builder. */
import type { EngineEvent, EventInputMap, EventName } from "@dawg/protocol";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event's payload without the fields every event carries (`sessionId`, `seq`, `time`). */
export type Fields<E extends EventName> = DistributiveOmit<
  EventInputMap[E],
  "sessionId" | "seq" | "time"
>;

/** A received event of one kind. */
export type EventOf<E extends EventName> = Extract<EngineEvent, { event: E }>;
