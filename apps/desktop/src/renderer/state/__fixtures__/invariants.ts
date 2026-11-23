/**
 * Properties every transcript the reducer builds must have, whatever stream it came from.
 * Returns a list of problems (empty when all hold), so a failing test shows every one of them.
 */
import type { EngineSlice, TranscriptItem } from "../types.ts";

export function transcriptProblems(state: EngineSlice, sessionId: string): string[] {
  const problems: string[] = [];
  const items: readonly TranscriptItem[] = state.transcripts[sessionId] ?? [];
  const session = state.sessions[sessionId];
  const refs = state.pending[sessionId] ?? [];

  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) problems.push(`duplicate item id ${item.id}`);
    ids.add(item.id);
  }

  // Pending refs and pending cards agree.
  for (const ref of refs) {
    const card = items.find((item) => item.id === `${ref.kind}:${ref.requestId}`);
    if (!card) problems.push(`pending ${ref.kind} ${ref.requestId} has no card`);
    else if ("state" in card && card.state !== "pending") {
      problems.push(`pending ${ref.requestId} has a ${card.state} card`);
    }
  }
  for (const item of items) {
    if (
      (item.kind === "permission" || item.kind === "question" || item.kind === "plan") &&
      item.state === "pending" &&
      !refs.some((ref) => ref.requestId === item.requestId)
    ) {
      problems.push(`card ${item.id} is pending without a pending ref`);
    }
  }

  // Turn structure.
  const firstIndex = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.turnId !== null && !firstIndex.has(item.turnId)) firstIndex.set(item.turnId, index);
  });
  items.forEach((item, index) => {
    if (item.kind === "user" && item.turnId !== null && firstIndex.get(item.turnId) !== index) {
      problems.push(`user message of ${item.turnId} is not the turn's first item`);
    }
    if (item.kind === "turn-summary" || (item.kind === "note" && item.id.startsWith("note:"))) {
      const later = items.slice(index + 1).find((other) => other.turnId === item.turnId);
      if (later) problems.push(`${item.id} is followed by ${later.id} of the same turn`);
    }
  });

  // Finished turns leave nothing streaming or running.
  const finished = new Set(
    items
      .filter((item) => item.kind === "turn-summary" || item.kind === "note")
      .map((item) => item.turnId),
  );
  if (session?.lastTurn?.stopReason) finished.add(session.lastTurn.turnId);
  for (const item of items) {
    if (item.turnId === null || !finished.has(item.turnId)) continue;
    if ((item.kind === "assistant" || item.kind === "reasoning") && item.streaming) {
      problems.push(`${item.id} still streams after its turn finished`);
    }
    if (item.kind === "reasoning" && item.durationMs === null) {
      problems.push(`${item.id} has no duration after its turn finished`);
    }
    if (item.kind === "tool" && item.state === "running") {
      problems.push(`${item.id} still runs after its turn finished`);
    }
  }

  // Cards sit next to what they belong to.
  items.forEach((item, index) => {
    if (item.kind === "permission") {
      const toolIndex = items.findIndex(
        (other) => other.kind === "tool" && other.toolCallId === item.request.toolCallId,
      );
      if (toolIndex !== -1 && toolIndex < index) {
        problems.push(`${item.id} comes after its tool item`);
      }
      const tool = items[toolIndex];
      if (tool?.kind === "tool" && tool.permissionRequestId === null) {
        problems.push(`tool ${tool.id} is not linked to ${item.id}`);
      }
    }
    if (item.kind === "reasoning") {
      const assistantIndex = items.findIndex(
        (other) => other.kind === "assistant" && other.messageId === item.messageId,
      );
      if (assistantIndex !== -1 && assistantIndex !== index + 1) {
        problems.push(`${item.id} is not directly before its text`);
      }
    }
    if ((item.kind === "assistant" || item.kind === "reasoning") && item.text.trim() === "") {
      problems.push(`${item.id} is empty`);
    }
  });

  if (session && session.highWaterSeq < 0) problems.push("negative high-water mark");
  return problems;
}
