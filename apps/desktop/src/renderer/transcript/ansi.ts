/**
 * A small parser for the colour codes commands print (ANSI SGR: `ESC [ … m`). It turns output
 * into plain-text segments with a style each; the component renders them as styled spans, so no
 * output is ever interpreted as HTML.
 *
 * Colours map to the theme's named colours rather than a fixed palette, so output reads well on
 * both the dark and the light terminal background. 256-colour and true-colour codes are
 * approximated to the nearest named colour. Every other escape sequence (cursor movement, line
 * clearing, window titles, hyperlinks) is removed, keeping any text it wraps.
 */

/** The theme colours output can use. "default" is the terminal's own ink. */
export type AnsiColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray";

export interface AnsiStyle {
  fg: AnsiColor | null;
  bg: AnsiColor | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

export const PLAIN_STYLE: Readonly<AnsiStyle> = Object.freeze({
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
});

const BASIC: readonly AnsiColor[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
];

/** Bright variants share the named colour; bright black reads as gray. */
function basic(index: number, bright: boolean): AnsiColor {
  if (bright && index === 0) return "gray";
  return BASIC[index] ?? "white";
}

/** The nearest named colour to an RGB value. */
export function nearestColor(r: number, g: number, b: number): AnsiColor {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2 / 255;
  const chroma = (max - min) / 255;
  if (chroma < 0.15) {
    if (lightness < 0.2) return "black";
    if (lightness < 0.75) return "gray";
    return "white";
  }
  let hue: number;
  if (max === r) hue = ((g - b) / (max - min)) * 60;
  else if (max === g) hue = ((b - r) / (max - min)) * 60 + 120;
  else hue = ((r - g) / (max - min)) * 60 + 240;
  if (hue < 0) hue += 360;
  if (hue < 20 || hue >= 330) return "red";
  if (hue < 70) return "yellow";
  if (hue < 165) return "green";
  if (hue < 200) return "cyan";
  if (hue < 260) return "blue";
  return "magenta";
}

/** A colour from the 256-colour palette. */
export function color256(n: number): AnsiColor {
  if (n < 8) return basic(n, false);
  if (n < 16) return basic(n - 8, true);
  if (n < 232) {
    const index = n - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return nearestColor(
      level(Math.floor(index / 36)),
      level(Math.floor(index / 6) % 6),
      level(index % 6),
    );
  }
  const gray = 8 + (n - 232) * 10;
  return nearestColor(gray, gray, gray);
}

function clampByte(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(255, value));
}

/**
 * Applies one SGR parameter list to a style. Unknown or malformed codes are ignored; an
 * extended colour with missing parts is skipped without consuming the codes after it wrongly.
 */
export function applySgr(style: AnsiStyle, params: readonly number[]): AnsiStyle {
  let next: AnsiStyle = { ...style };
  if (params.length === 0) return { ...PLAIN_STYLE };
  for (let i = 0; i < params.length; i++) {
    const code = params[i] ?? 0;
    if (code === 0) next = { ...PLAIN_STYLE };
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 3) next.italic = true;
    else if (code === 23) next.italic = false;
    else if (code === 4) next.underline = true;
    else if (code === 24) next.underline = false;
    else if (code >= 30 && code <= 37) next.fg = basic(code - 30, false);
    else if (code >= 90 && code <= 97) next.fg = basic(code - 90, true);
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47) next.bg = basic(code - 40, false);
    else if (code >= 100 && code <= 107) next.bg = basic(code - 100, true);
    else if (code === 49) next.bg = null;
    else if (code === 38 || code === 48) {
      const mode = params[i + 1];
      let color: AnsiColor | null = null;
      if (mode === 5) {
        const n = clampByte(params[i + 2]);
        if (n !== null) color = color256(n);
        i += 2;
      } else if (mode === 2) {
        const r = clampByte(params[i + 2]);
        const g = clampByte(params[i + 3]);
        const b = clampByte(params[i + 4]);
        if (r !== null && g !== null && b !== null) color = nearestColor(r, g, b);
        i += 4;
      } else {
        // Unknown form: stop reading this list rather than misread what follows.
        break;
      }
      if (color !== null) {
        if (code === 38) next.fg = color;
        else next.bg = color;
      }
    }
  }
  return next;
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline
  );
}

/**
 * Applies carriage returns the way a terminal shows them: within a line, text after a `\r`
 * replaces what came before (progress bars redraw themselves this way). `\r\n` is a line break.
 */
export function applyCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((line) => {
      const trimmed = line.replace(/\r+$/, "");
      const last = trimmed.lastIndexOf("\r");
      return last === -1 ? trimmed : trimmed.slice(last + 1);
    })
    .join("\n");
}

// CSI (ESC [ params intermediates final), OSC (ESC ] … BEL or ESC \), other two-byte escapes, and
// the C1 form of CSI. Captures the CSI parameters and final byte.
const ESCAPE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control codes is the point
  /\u001b\[([0-?]*)[ -/]*([@-~])|\u009b([0-?]*)[ -/]*([@-~])|\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)|\u001b[PX^_][\s\S]*?(?:\u001b\\|$)|\u001b[@-Z\\-_]|\u001b/g;

// Control characters other than tab and newline (backspace, bell, …), shown as nothing.
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g;

/** Splits output into styled segments. Adjacent text with the same style is merged. */
export function parseAnsi(input: string, initial: AnsiStyle = PLAIN_STYLE): AnsiSegment[] {
  const text = applyCarriageReturns(input);
  const segments: AnsiSegment[] = [];
  let style: AnsiStyle = { ...initial };
  let last = 0;

  const push = (chunk: string) => {
    const clean = chunk.replace(CONTROL, "");
    if (clean === "") return;
    const previous = segments[segments.length - 1];
    if (previous && sameStyle(previous.style, style)) previous.text += clean;
    else segments.push({ text: clean, style });
  };

  ESCAPE.lastIndex = 0;
  for (let match = ESCAPE.exec(text); match !== null; match = ESCAPE.exec(text)) {
    push(text.slice(last, match.index));
    last = match.index + match[0].length;
    const params = match[1] ?? match[3];
    const final = match[2] ?? match[4];
    if (final === "m" && params !== undefined) {
      // Private parameters ("<", "=", ">", "?") are not SGR.
      if (/^[\d;:]*$/.test(params)) {
        const list =
          params === "" ? [] : params.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
        style = applySgr(style, list);
      }
    }
    if (match[0].length === 0) ESCAPE.lastIndex++;
  }
  push(text.slice(last));
  return segments;
}

/** Output without any escape codes, for copying. */
export function stripAnsi(input: string): string {
  return parseAnsi(input)
    .map((segment) => segment.text)
    .join("");
}
