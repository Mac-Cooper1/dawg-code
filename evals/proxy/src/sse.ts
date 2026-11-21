/**
 * Incremental parser for server-sent events.
 * Format: https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream
 */

export interface SseEvent {
  /** The `event:` field, or "message" when absent. */
  event: string;
  /** The `data:` fields joined with "\n". */
  data: string;
}

export class SseParser {
  readonly #onEvent: (event: SseEvent) => void;
  readonly #decoder = new TextDecoder("utf-8");
  #buffer = "";
  #eventName = "";
  #data: string[] = [];
  #sawCr = false;

  constructor(onEvent: (event: SseEvent) => void) {
    this.#onEvent = onEvent;
  }

  /** Feed raw bytes (or already-decoded text). */
  push(chunk: Uint8Array | string): void {
    const text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    this.#consume(text);
  }

  /** Flush any final event that was not followed by a blank line. */
  end(): void {
    const rest = this.#decoder.decode();
    if (rest) this.#consume(rest);
    if (this.#buffer.length > 0) {
      this.#line(this.#buffer);
      this.#buffer = "";
    }
    this.#dispatch();
  }

  #consume(text: string): void {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 10 /* \n */) {
        if (this.#sawCr && i === start && this.#buffer === "") {
          // second half of a \r\n pair
          this.#sawCr = false;
          start = i + 1;
          continue;
        }
        this.#line(this.#buffer + text.slice(start, i));
        this.#buffer = "";
        this.#sawCr = false;
        start = i + 1;
      } else if (ch === 13 /* \r */) {
        this.#line(this.#buffer + text.slice(start, i));
        this.#buffer = "";
        this.#sawCr = true;
        start = i + 1;
      } else if (this.#sawCr) {
        this.#sawCr = false;
      }
    }
    this.#buffer += text.slice(start);
  }

  #line(line: string): void {
    if (line === "") {
      this.#dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.#data.push(value);
    else if (field === "event") this.#eventName = value;
  }

  #dispatch(): void {
    if (this.#data.length === 0) {
      this.#eventName = "";
      return;
    }
    const event: SseEvent = { event: this.#eventName || "message", data: this.#data.join("\n") };
    this.#eventName = "";
    this.#data = [];
    this.#onEvent(event);
  }
}

/** Format one SSE event with a named type, as the Anthropic Messages API does. */
export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
