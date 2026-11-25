/**
 * Background commands in the mock engine: their output, read in pages as the real engine reads
 * its output files (`background.output`), and their state in a snapshot.
 */
import type { BackgroundTask } from "@dawg/protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * At most `limit` bytes of `output` from byte `offset`, never splitting a character: a page ends
 * before a character cut off at the limit, an offset inside a character moves on to the next one,
 * and a page holds one whole character even when the limit is smaller, so paging always moves on.
 */
export function outputPage(
  output: string,
  offset: number,
  limit: number,
): { text: string; nextOffset: number; totalBytes: number } {
  const bytes = encoder.encode(output);
  const total = bytes.length;
  let start = Math.min(Math.max(0, Math.floor(offset)), total);
  while (start < total && isContinuation(bytes[start])) start += 1;
  let end = Math.min(total, start + Math.max(1, limit));
  while (end > start && end < total && isContinuation(bytes[end])) end -= 1;
  if (end === start && start < total) {
    end = start + 1;
    while (end < total && isContinuation(bytes[end])) end += 1;
  }
  return { text: decoder.decode(bytes.subarray(start, end)), nextOffset: end, totalBytes: total };
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/** A task as a snapshot shows it: a running one's output counted so far. */
export function withOutput(task: BackgroundTask, output: string | undefined): BackgroundTask {
  if (task.status !== "running" || output === undefined) return { ...task };
  return { ...task, outputBytes: Math.max(task.outputBytes, byteLength(output)) };
}
