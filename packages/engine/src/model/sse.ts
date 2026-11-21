/**
 * An incremental server-sent-events reader, following the WHATWG event-stream rules: lines end in
 * CRLF, LF or CR (a CR at the end of a network chunk waits for the next chunk before deciding),
 * comment lines start with ":", several `data:` lines join with "\n", and a blank line dispatches
 * the event. Bytes are decoded in streaming mode, so a character split across chunks survives.
 *
 * One addition: an `error: <json>` line (an older llama-server convention) is reported as an
 * event named "error".
 */

export interface SseEvent {
  /** The `event:` field, or "message" when none was given. */
  event: string;
  data: string;
}

export class SseParser {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private dataLines: string[] = [];
  private eventName = "";
  private started = false;

  /** Feeds one network chunk and returns the events it completed. */
  push(chunk: Uint8Array): SseEvent[] {
    return this.consume(this.decoder.decode(chunk, { stream: true }), false);
  }

  /**
   * Ends the stream. An event that was not followed by a blank line is still returned: servers
   * that close the connection straight after their last `data:` line are common.
   */
  end(): SseEvent[] {
    const events = this.consume(this.decoder.decode(), true);
    if (this.buffer.length > 0) {
      this.line(this.buffer, events);
      this.buffer = "";
    }
    this.dispatch(events);
    return events;
  }

  private consume(text: string, final: boolean): SseEvent[] {
    let input = this.buffer + text;
    if (!this.started && input.length > 0) {
      this.started = true;
      if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
    }
    const events: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < input.length; i++) {
      const c = input.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      if (c === 13) {
        // A CR at the end of the buffer may be the first half of a CRLF.
        if (i === input.length - 1 && !final) break;
        this.line(input.slice(start, i), events);
        if (input.charCodeAt(i + 1) === 10) i++;
      } else {
        this.line(input.slice(start, i), events);
      }
      start = i + 1;
    }
    this.buffer = input.slice(start);
    return events;
  }

  private line(line: string, events: SseEvent[]): void {
    if (line.length === 0) {
      this.dispatch(events);
      return;
    }
    if (line.charCodeAt(0) === 58) return; // ":" comment or keep-alive
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field === "data") {
      this.dataLines.push(value);
    } else if (field === "event") {
      this.eventName = value;
    } else if (field === "error") {
      this.eventName = "error";
      this.dataLines.push(value);
    }
    // "id", "retry" and unknown fields carry nothing we use.
  }

  private dispatch(events: SseEvent[]): void {
    if (this.dataLines.length > 0) {
      events.push({ event: this.eventName || "message", data: this.dataLines.join("\n") });
    }
    this.dataLines = [];
    this.eventName = "";
  }
}
