/**
 * The client-side message queue (the protocol refuses a prompt while a turn runs, so clients
 * queue follow-ups themselves) and slash-command parsing. Pure helpers over `ui.queues`.
 */
import type { CommandInfo, SessionId } from "@dawg/protocol";
import type { QueuedMessage } from "./types.ts";

export type Queues = Record<SessionId, QueuedMessage[]>;

function withQueue(queues: Queues, sessionId: SessionId, queue: QueuedMessage[]): Queues {
  const next = { ...queues };
  if (queue.length === 0) delete next[sessionId];
  else next[sessionId] = queue;
  return next;
}

export function enqueue(queues: Queues, sessionId: SessionId, message: QueuedMessage): Queues {
  return withQueue(queues, sessionId, [...(queues[sessionId] ?? []), message]);
}

export function removeQueued(queues: Queues, sessionId: SessionId, queueId: string): Queues {
  const queue = queues[sessionId];
  if (!queue?.some((message) => message.id === queueId)) return queues;
  return withQueue(
    queues,
    sessionId,
    queue.filter((message) => message.id !== queueId),
  );
}

export function setQueuedState(
  queues: Queues,
  sessionId: SessionId,
  queueId: string,
  state: QueuedMessage["state"],
): Queues {
  const queue = queues[sessionId];
  if (!queue?.some((message) => message.id === queueId && message.state !== state)) return queues;
  return withQueue(
    queues,
    sessionId,
    queue.map((message) => (message.id === queueId ? { ...message, state } : message)),
  );
}

/** Stopping or failing a turn holds every queued message: nothing is sent behind the person's back. */
export function holdAll(queues: Queues, sessionId: SessionId): Queues {
  const queue = queues[sessionId];
  if (!queue?.some((message) => message.state === "queued")) return queues;
  return withQueue(
    queues,
    sessionId,
    queue.map((message) => (message.state === "queued" ? { ...message, state: "held" } : message)),
  );
}

/** The oldest message waiting to be sent when the running turn completes. */
export function nextQueued(queue: readonly QueuedMessage[] | undefined): QueuedMessage | null {
  return queue?.find((message) => message.state === "queued") ?? null;
}

/** "/name args" when `name` is one of the session's commands; otherwise null (sent as a prompt). */
export function parseCommand(
  text: string,
  commands: readonly CommandInfo[],
): { name: string; args: string } | null {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = match?.[1];
  if (!match || name === undefined) return null;
  if (!commands.some((command) => command.name === name)) return null;
  return { name, args: match[2] ?? "" };
}
