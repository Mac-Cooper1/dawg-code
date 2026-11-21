import { describe, expect, test } from "vitest";
import { type SseEvent, SseParser } from "./sse.ts";

const encoder = new TextEncoder();

/** Feeds `pieces` (strings or raw bytes) one by one and returns every event, including at end. */
function parse(pieces: (string | Uint8Array)[]): SseEvent[] {
  const parser = new SseParser();
  const events: SseEvent[] = [];
  for (const piece of pieces) {
    events.push(...parser.push(typeof piece === "string" ? encoder.encode(piece) : piece));
  }
  events.push(...parser.end());
  return events;
}

const data = (events: SseEvent[]) => events.map((e) => e.data);

describe("SseParser", () => {
  test("plain events and [DONE]", () => {
    expect(data(parse(['data: {"a":1}\n\ndata: [DONE]\n\n']))).toEqual(['{"a":1}', "[DONE]"]);
  });

  test("an event split at every possible byte", () => {
    const stream = 'data: {"text":"héllo"}\n\ndata: [DONE]\n\n';
    const bytes = encoder.encode(stream);
    for (let cut = 1; cut < bytes.length; cut++) {
      const events = parse([bytes.slice(0, cut), bytes.slice(cut)]);
      expect(data(events)).toEqual(['{"text":"héllo"}', "[DONE]"]);
    }
  });

  test("one byte at a time, with multi-byte characters", () => {
    const stream = 'data: {"t":"日本語 👋🏽"}\r\n\r\n';
    const bytes = encoder.encode(stream);
    const pieces = Array.from(bytes, (b) => Uint8Array.of(b));
    expect(data(parse(pieces))).toEqual(['{"t":"日本語 👋🏽"}']);
  });

  test("CRLF, lone CR, and a CR split from its LF across chunks", () => {
    expect(data(parse(["data: a\r\n\r\ndata: b\r\r"]))).toEqual(["a", "b"]);
    expect(data(parse(["data: a\r", "\n\r", "\ndata: b\n\n"]))).toEqual(["a", "b"]);
  });

  test("comments and keep-alive lines are skipped", () => {
    const events = parse([": ping\n\n", ":\n\n", "data: x\n: in the middle\n\n"]);
    expect(data(events)).toEqual(["x"]);
  });

  test("multi-line data joins with newlines; event names and other fields", () => {
    const events = parse(["event: update\nid: 7\nretry: 10\ndata: one\ndata:two\n\n"]);
    expect(events).toEqual([{ event: "update", data: "one\ntwo" }]);
  });

  test("a final event without its blank line is still delivered", () => {
    expect(data(parse(['data: {"last":true}']))).toEqual(['{"last":true}']);
    expect(data(parse(['data: {"last":true}\n']))).toEqual(['{"last":true}']);
  });

  test("a byte-order mark at the start is ignored", () => {
    expect(data(parse(["﻿data: x\n\n"]))).toEqual(["x"]);
  });

  test("an `error:` line is reported as an error event", () => {
    expect(parse(['error: {"message":"boom"}\n\n'])).toEqual([
      { event: "error", data: '{"message":"boom"}' },
    ]);
  });

  test("a field with no colon and blank events produce nothing", () => {
    expect(parse(["data\n\n\n\n"])).toEqual([{ event: "message", data: "" }]);
    expect(parse(["\n\n\n"])).toEqual([]);
  });
});
