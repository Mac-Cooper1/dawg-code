/**
 * WCAG 2.2 AA contrast of the design tokens, read from tokens.css, in both themes and with
 * macOS "Increase contrast" (prefers-contrast: more).
 *
 * - Text: 4.5:1 against every background it is drawn on (1.4.3). The UI's text is 11–14 px, so
 *   nothing qualifies as large text and every pair below is held to 4.5:1.
 * - Focus ring and status marks: 3:1 against the colours next to them (1.4.11).
 *
 * A background written "a over b" is the translucent token `a` (a hover fill, a tint) laid over
 * the solid `b`, as the window draws it. When a component puts a colour on a new background, add
 * the pair here.
 */
import { describe, expect, it } from "vitest";

// The test runs in Node, but the renderer's TypeScript has no Node types (and Vitest hands CSS
// imports over empty), so the file is read through a module name TypeScript does not resolve.
const NODE_FS: string = "node:fs";
const fs = (await import(/* @vite-ignore */ NODE_FS)) as {
  readFileSync(path: URL, encoding: "utf8"): string;
};
const CSS = fs.readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

// ---------------------------------------------------------------------------------------------
// Reading tokens.css
// ---------------------------------------------------------------------------------------------

type Tokens = Record<string, string>;

/** The body of the rule that starts with `selector {`, searching from `from`. */
function ruleBody(source: string, selector: string, from = 0): { body: string; end: number } {
  const start = source.indexOf(`${selector} {`, from);
  if (start === -1) throw new Error(`tokens.css has no rule for ${selector}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return { body: source.slice(open + 1, close), end: close + 1 };
}

function declarations(body: string): Tokens {
  const tokens: Tokens = {};
  for (const match of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[match[1] as string] = (match[2] as string).trim();
  }
  return tokens;
}

/** The token sets of the four ways the window can look, cascaded as the browser does. */
function readThemes() {
  const mediaAt = CSS.indexOf("@media (prefers-contrast: more)");
  if (mediaAt === -1) throw new Error("tokens.css has no prefers-contrast: more block");
  const plain = CSS.slice(0, mediaAt);
  const media = CSS.slice(mediaAt);

  const root = declarations(ruleBody(plain, ":root").body);
  const light = declarations(ruleBody(plain, ':root[data-theme="light"]').body);
  const moreRoot = declarations(ruleBody(media, ":root").body);
  const moreLight = declarations(ruleBody(media, ':root[data-theme="light"]').body);

  // `:root[data-theme="light"]` outranks `:root`, whichever comes first, so the light theme's own
  // values beat the media block's `:root` ones.
  return {
    dark: { ...root },
    light: { ...root, ...light },
    "dark, more contrast": { ...root, ...moreRoot },
    "light, more contrast": { ...root, ...moreRoot, ...light, ...moreLight },
  } satisfies Record<string, Tokens>;
}

// ---------------------------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------------------------

type Rgba = readonly [number, number, number, number];

function parseColour(value: string): Rgba {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1] as string;
    const full =
      digits.length === 3
        ? digits
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : digits;
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
      1,
    ];
  }
  const rgb = value.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const parts = (rgb[1] as string)
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
  }
  throw new Error(`Cannot read the colour ${value}`);
}

function over(top: Rgba, below: Rgba): Rgba {
  const a = top[3];
  return [
    top[0] * a + below[0] * (1 - a),
    top[1] * a + below[1] * (1 - a),
    top[2] * a + below[2] * (1 - a),
    1,
  ];
}

function luminance([r, g, b]: Rgba): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** "hover over side": the tokens composited from the top down onto the last, solid one. */
function resolve(tokens: Tokens, spec: string): Rgba {
  const names = spec.split(" over ");
  const read = (name: string) => {
    const value = tokens[name];
    if (value === undefined) throw new Error(`No token --${name}`);
    return parseColour(value);
  };
  let colour = read(names[names.length - 1] as string);
  if (colour[3] < 1) throw new Error(`--${names.at(-1)} is translucent; say what it lies over`);
  for (let i = names.length - 2; i >= 0; i--) colour = over(read(names[i] as string), colour);
  return colour;
}

// ---------------------------------------------------------------------------------------------
// The pairs the window draws
// ---------------------------------------------------------------------------------------------

interface Pair {
  fg: string;
  bg: string;
  min: number;
  /** Where the window draws it. */
  where: string;
}

const TEXT = 4.5;
const UI = 3;

const SURFACES = ["bg", "side", "panel", "panel-2", "code"];

function onEach(fg: string, backgrounds: readonly string[], min: number, where: string): Pair[] {
  return backgrounds.map((bg) => ({ fg, bg, min, where }));
}

const PAIRS: Pair[] = [
  // Primary, secondary and muted text on the window, sidebar, panels, cards and code.
  ...onEach("ink", SURFACES, TEXT, "text"),
  ...onEach("ink-2", SURFACES, TEXT, "secondary text"),
  ...onEach("ink-3", SURFACES, TEXT, "muted text, placeholders, key hints"),
  // Hover and selection fills under text: sidebar rows, menu items, the palette's active row.
  ...onEach(
    "ink",
    ["hover over side", "active over side", "hover over panel", "active over panel"],
    TEXT,
    "a hovered or selected row's title",
  ),
  ...onEach(
    "ink-3",
    ["hover over side", "active over side", "hover over panel", "active over panel"],
    TEXT,
    "a hovered or selected row's subtitle and time",
  ),
  ...onEach("ink-2", ["hover over side", "hover over panel"], TEXT, "chips and counts"),
  ...onEach("ink", ["sel over panel"], TEXT, "a chosen option in a question card"),
  ...onEach("ink-3", ["sel over panel"], TEXT, "a chosen option's description"),
  // Accent text: links, "Manage models…", the Recommended tag.
  ...onEach("acc-text", [...SURFACES, "sel over panel", "active over side"], TEXT, "accent text"),
  // Text on fills.
  { fg: "acc-ink", bg: "acc", min: TEXT, where: "a primary button's label" },
  { fg: "on-red", bg: "red", min: TEXT, where: "a destructive button's label" },
  { fg: "on-amber", bg: "amber", min: TEXT, where: "the needs-you mark's “!”" },
  // Status colours as text.
  ...["amber", "blue", "red", "green"].flatMap((status) =>
    onEach(status, ["bg", "side", "panel", "panel-2"], TEXT, `${status} status text`),
  ),
  { fg: "amber", bg: "amber-bg over panel", min: TEXT, where: "a decision card's header" },
  { fg: "red", bg: "red-bg over bg", min: TEXT, where: "an error notice" },
  { fg: "red", bg: "red-bg over panel", min: TEXT, where: "a red tag" },
  { fg: "green", bg: "ok-bg over panel", min: TEXT, where: "a green tag" },
  // Diffs and the terminal.
  { fg: "add-ink", bg: "add-bg over code", min: TEXT, where: "an added line" },
  { fg: "del-ink", bg: "del-bg over code", min: TEXT, where: "a removed line" },
  { fg: "add-ink", bg: "side", min: TEXT, where: "the title bar's +lines" },
  { fg: "del-ink", bg: "side", min: TEXT, where: "the title bar's −lines" },
  { fg: "term-ink", bg: "term-bg", min: TEXT, where: "terminal text" },
  // The focus ring, against what it sits on (it is drawn 1 px off the control).
  ...onEach("focus", SURFACES, UI, "the focus ring"),
  ...onEach("focus", ["sel over panel", "active over side"], UI, "the focus ring on a selection"),
  // Status marks in the sidebar, on a plain and on the selected row.
  ...["amber", "blue", "red", "acc-text", "ink-3"].flatMap((mark) =>
    onEach(mark, ["side", "active over side", "panel"], UI, `the ${mark} status mark`),
  ),
  { fg: "green", bg: "side", min: UI, where: "the model-ready dot" },
];

/** Under Increase contrast, lines and borders are strong enough to find a control by its edge. */
const MORE_CONTRAST_PAIRS: Pair[] = [
  ...onEach("line-2", ["bg", "side", "panel", "panel-2"], UI, "field and button borders"),
  ...onEach("edge", ["bg", "side", "panel", "panel-2"], UI, "the composer's edge"),
  ...onEach("ink-3", ["bg", "side", "panel"], 7, "muted text, near secondary"),
];

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

const THEMES = readThemes();

function failures(tokens: Tokens, pairs: readonly Pair[]): string[] {
  return pairs.flatMap((pair) => {
    const ratio = contrastRatio(resolve(tokens, pair.fg), resolve(tokens, pair.bg));
    return ratio + 1e-9 >= pair.min
      ? []
      : [`--${pair.fg} on ${pair.bg} (${pair.where}): ${ratio.toFixed(2)}:1, needs ${pair.min}:1`];
  });
}

describe("contrast of the design tokens", () => {
  it("computes ratios as WCAG does", () => {
    expect(contrastRatio(parseColour("#000"), parseColour("#fff"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColour("#777777"), parseColour("#ffffff"))).toBeCloseTo(4.48, 2);
    expect(over(parseColour("rgba(255, 255, 255, 0.5)"), parseColour("#000000"))[0]).toBe(127.5);
  });

  it.each(Object.entries(THEMES))("meets WCAG 2.2 AA in %s", (_name, tokens) => {
    expect(failures(tokens, PAIRS)).toEqual([]);
  });

  it.each([
    ["dark, more contrast", THEMES["dark, more contrast"]],
    ["light, more contrast", THEMES["light, more contrast"]],
  ])("strengthens lines and muted text in %s", (_name, tokens) => {
    expect(failures(tokens, MORE_CONTRAST_PAIRS)).toEqual([]);
    expect(tokens["focus-width"]).toBe("3px");
  });

  it("draws a 2 px focus ring by default", () => {
    expect(THEMES.dark["focus-width"]).toBe("2px");
    expect(THEMES.light["focus-width"]).toBe("2px");
  });
});
