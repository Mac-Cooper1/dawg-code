import { describe, expect, test } from "vitest";
import { type SseEvent, SseParser } from "./sse.ts";

function parseAll(pieces: (string | Uint8Array)[]): SseEvent[] {
  const events: SseEvent[] = [];
  const parser = new SseParser((e) => events.push(e));
  for (const piece of pieces) parser.push(piece);
  parser.end();
  return events;
}

describe("SseParser", () => {
  test("parses data and event fields, ignores comments", () => {
    const events = parseAll([': keepalive\n\nevent: ping\ndata: {"a":1}\n\ndata: x\n\n']);
    expect(events).toEqual([
      { event: "ping", data: '{"a":1}' },
      { event: "message", data: "x" },
    ]);
  });

  test("handles events split at every byte, CRLF line endings and multi-byte characters", () => {
    const text = 'data: {"t":"héllo ✓"}\r\n\r\ndata: line1\r\ndata: line2\r\n\r\n';
    const bytes = new TextEncoder().encode(text);
    const pieces = [...bytes].map((b) => new Uint8Array([b]));
    expect(parseAll(pieces)).toEqual([
      { event: "message", data: '{"t":"héllo ✓"}' },
      { event: "message", data: "line1\nline2" },
    ]);
  });

  test("handles bare CR line endings and a final event without a blank line", () => {
    expect(parseAll(["data: a\r\rdata: b"])).toEqual([
      { event: "message", data: "a" },
      { event: "message", data: "b" },
    ]);
  });
});
