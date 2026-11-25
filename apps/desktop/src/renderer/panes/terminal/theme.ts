/**
 * Terminal colours from the design tokens (styles/tokens.css), so a shell matches the window in
 * both themes. xterm wants concrete colours, so the tokens are read from the page and mixed here:
 * magenta and cyan have no token of their own and are mixed from red, blue and green, as the
 * transcript's ANSI colours are.
 */
import type { ResolvedTheme } from "../../../shared/bridge.ts";
import type { TerminalTheme } from "./view.ts";

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** The tokens as tokens.css sets them, for when the page has no styles (tests). */
const FALLBACK: Record<ResolvedTheme, Record<string, string>> = {
  dark: {
    "--term-bg": "#0e0f11",
    "--term-ink": "#d9dbdf",
    "--acc-text": "#c8f03c",
    "--ink": "#ecedef",
    "--ink-2": "#b9bcc2",
    "--ink-3": "#90949b",
    "--line-2": "#3b3e45",
    "--red": "#ff7b72",
    "--green": "#6cd38d",
    "--amber": "#f6b44a",
    "--blue": "#7ea8ff",
  },
  light: {
    "--term-bg": "#fbfbf9",
    "--term-ink": "#25272b",
    "--acc-text": "#4a6600",
    "--ink": "#17181a",
    "--ink-2": "#45484d",
    "--ink-3": "#61656c",
    "--line-2": "#cfcfc6",
    "--red": "#c2261e",
    "--green": "#1a7536",
    "--amber": "#a34a00",
    "--blue": "#1d5bd1",
  },
};

export function parseColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)?.[1];
  if (hex) {
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : hex;
    return {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
      a: full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1,
    };
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text)?.[1];
  if (rgb) {
    const parts = rgb
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    const [r, g, b, a = 1] = parts;
    if ([r, g, b, a].some((part) => part === undefined || Number.isNaN(part))) return null;
    return { r: r as number, g: g as number, b: b as number, a };
  }
  return null;
}

function hex2(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, "0");
}

function toHex(color: Rgba): string {
  const alpha = color.a < 1 ? hex2(color.a * 255) : "";
  return `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}${alpha}`;
}

/** `weight` of `a` and the rest of `b`, like CSS `color-mix(in srgb, a weight, b)`. */
export function mix(a: string, b: string, weight: number): string {
  const first = parseColor(a);
  const second = parseColor(b);
  if (!first || !second) return a;
  return toHex({
    r: first.r * weight + second.r * (1 - weight),
    g: first.g * weight + second.g * (1 - weight),
    b: first.b * weight + second.b * (1 - weight),
    a: first.a * weight + second.a * (1 - weight),
  });
}

export function withAlpha(color: string, alpha: number): string {
  const parsed = parseColor(color);
  return parsed ? toHex({ ...parsed, a: alpha }) : color;
}

/** Reads a token from the page, falling back to its value in tokens.css. */
export type TokenReader = (name: string) => string;

export function pageTokens(theme: ResolvedTheme): TokenReader {
  const style = typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null;
  return (name) => {
    const value = style?.getPropertyValue(name).trim() ?? "";
    return value !== "" ? value : (FALLBACK[theme][name] ?? "#808080");
  };
}

/** The terminal's colours for a theme. */
export function terminalTheme(
  theme: ResolvedTheme,
  token: TokenReader = pageTokens(theme),
): TerminalTheme {
  const background = token("--term-bg");
  const ink = token("--ink");
  const red = token("--red");
  const green = token("--green");
  const blue = token("--blue");
  const amber = token("--amber");
  const magenta = mix(red, blue, 0.55);
  const cyan = mix(blue, green, 0.5);
  // ANSI black and white keep their meaning: black is the dark end, white the light end.
  const dark = theme === "dark";
  const black = dark ? token("--line-2") : ink;
  const white = dark ? token("--ink-2") : token("--line-2");
  return {
    background,
    foreground: token("--term-ink"),
    cursor: token("--acc-text"),
    cursorAccent: background,
    selectionBackground: withAlpha(token("--acc-text"), dark ? 0.3 : 0.22),
    selectionInactiveBackground: withAlpha(token("--ink-3"), 0.25),
    black,
    red,
    green,
    yellow: amber,
    blue,
    magenta,
    cyan,
    white,
    brightBlack: token("--ink-3"),
    brightRed: mix(red, ink, 0.85),
    brightGreen: mix(green, ink, 0.85),
    brightYellow: mix(amber, ink, 0.85),
    brightBlue: mix(blue, ink, 0.85),
    brightMagenta: mix(magenta, ink, 0.85),
    brightCyan: mix(cyan, ink, 0.85),
    brightWhite: dark ? ink : token("--ink-3"),
  };
}

/** The monospace face and code size the rest of the app uses. */
export function terminalFont(): { fontFamily: string; fontSize: number } {
  const style = typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null;
  const family = style?.getPropertyValue("--mono").trim() ?? "";
  return {
    fontFamily: family !== "" ? family : 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 12,
  };
}
