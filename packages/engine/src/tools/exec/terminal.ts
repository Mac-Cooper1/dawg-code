/**
 * Removes terminal control sequences from command output so the model sees plain text.
 *
 * Output arrives in arbitrary chunks, so a sequence can be split between two of them. The
 * stripper is a small state machine whose state carries over from one chunk to the next.
 */

const ESC = 0x1b;
const BEL = 0x07;
/** Sequences longer than this are not real control sequences; give up and drop them. */
const MAX_CSI_LENGTH = 64;
const MAX_STRING_LENGTH = 16 * 1024;

type State =
  | "text"
  | "escape"
  | "escape-intermediate"
  | "csi"
  /** OSC, DCS, SOS, PM or APC: a string ended by BEL (OSC only) or ST. */
  | "string"
  /** An ESC inside a string, which may start the ST terminator (ESC \). */
  | "string-escape";

export class EscapeStripper {
  private state: State = "text";
  private length = 0;
  private oscString = false;

  /** Returns the text of `chunk` with control sequences and stray control characters removed. */
  push(chunk: string): string {
    let out = "";
    let runStart = -1;
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i);
      if (this.state === "text") {
        if (isPrintable(code)) {
          if (runStart < 0) runStart = i;
          continue;
        }
        if (runStart >= 0) {
          out += chunk.slice(runStart, i);
          runStart = -1;
        }
        this.startControl(code);
        continue;
      }
      if (!this.consume(code)) {
        // The sequence was malformed: the character is ordinary text again.
        i -= 1;
      }
    }
    if (runStart >= 0) out += chunk.slice(runStart);
    return out;
  }

  /** Ends the stream. A sequence cut off at the very end is dropped. */
  flush(): string {
    this.state = "text";
    this.length = 0;
    return "";
  }

  private startControl(code: number): void {
    if (code === ESC) {
      this.enter("escape");
    } else if (code === 0x9b) {
      this.enter("csi");
    } else if (code === 0x9d) {
      this.oscString = true;
      this.enter("string");
    } else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      this.oscString = false;
      this.enter("string");
    }
    // Any other control character is simply dropped.
  }

  private enter(state: State): void {
    this.state = state;
    this.length = 0;
  }

  /** Feeds one character to an open sequence. Returns false when it must be re-read as text. */
  private consume(code: number): boolean {
    this.length += 1;
    switch (this.state) {
      case "escape":
        if (code === 0x5b) this.enter("csi");
        else if (code === 0x5d) {
          this.oscString = true;
          this.enter("string");
        } else if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
          this.oscString = false;
          this.enter("string");
        } else if (code >= 0x20 && code <= 0x2f) this.state = "escape-intermediate";
        else if (code >= 0x30 && code <= 0x7e) this.state = "text";
        else if (code === ESC) this.enter("escape");
        else {
          this.state = "text";
          return false;
        }
        return true;
      case "escape-intermediate":
        if (code >= 0x20 && code <= 0x2f && this.length < MAX_CSI_LENGTH) return true;
        this.state = "text";
        return code >= 0x30 && code <= 0x7e;
      case "csi":
        if (code >= 0x20 && code <= 0x3f && this.length < MAX_CSI_LENGTH) return true;
        this.state = "text";
        return code >= 0x40 && code <= 0x7e;
      case "string":
        if ((code === BEL && this.oscString) || code === 0x9c) this.state = "text";
        else if (code === ESC) this.state = "string-escape";
        else if (this.length > MAX_STRING_LENGTH) this.state = "text";
        return true;
      case "string-escape":
        if (code === 0x5c) {
          this.state = "text";
          return true;
        }
        // ESC followed by something else ends the string and starts a new escape sequence.
        this.enter("escape");
        return this.consume(code);
      default:
        this.state = "text";
        return false;
    }
  }
}

function isPrintable(code: number): boolean {
  if (code >= 0x20 && code < 0x7f) return true;
  if (code === 0x0a || code === 0x09 || code === 0x0d) return true;
  if (code < 0x20 || code === 0x7f) return false;
  // C1 control characters.
  return code < 0x80 || code > 0x9f;
}

/** Strips a complete piece of text in one go. */
export function stripTerminalEscapes(text: string): string {
  const stripper = new EscapeStripper();
  return stripper.push(text) + stripper.flush();
}

/**
 * Applies carriage returns the way a terminal would show the final screen line: text before a
 * lone `\r` on a line is overwritten by what follows it. Progress bars collapse to their last
 * state. `\r\n` line endings become `\n`.
 */
export function collapseCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? "";
    if (!line.includes("\r")) continue;
    line = line.replace(/\r+$/, "");
    const last = line.lastIndexOf("\r");
    lines[i] = last >= 0 ? line.slice(last + 1) : line;
  }
  return lines.join("\n");
}
