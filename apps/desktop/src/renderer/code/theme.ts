/**
 * Monaco's colours, made from the app's design tokens (`styles/tokens.css`) as the page shows
 * them right now, so the editors match the window in dark and light alike. Syntax colours follow
 * the Markdown code blocks (`markdown/highlight.module.css`): keywords blue, strings green,
 * comments muted, numbers amber, functions and types in the accent text colour, tags red.
 */
import type { editor } from "monaco-editor/editor/editor.api.js";

/** Reads one token, such as "--panel", as the page resolves it. */
export type TokenReader = (name: string) => string;

/** The theme name Monaco knows the app's colours by. */
export const MONACO_THEME = "dawg";

/** Reads tokens from the document root's computed style. */
export function documentTokens(): TokenReader {
  const style = getComputedStyle(document.documentElement);
  return (name) => style.getPropertyValue(name).trim();
}

/** Red, green, blue (0–255) and alpha (0–1) of a CSS colour, or null when it is not one. */
function parseColor(value: string): [number, number, number, number] | null {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const byte = (index: number) => Number.parseInt(full.slice(index * 2, index * 2 + 2), 16);
    return [byte(0), byte(1), byte(2), full.length === 8 ? byte(3) / 255 : 1];
  }
  const parts = /^rgba?\(([^)]*)\)$/
    .exec(text)?.[1]
    ?.split(/[\s,/]+/)
    .filter(Boolean);
  if (!parts || parts.length < 3) return null;
  const [r, g, b, alpha] = parts;
  const a =
    alpha === undefined
      ? 1
      : alpha.endsWith("%")
        ? Number(alpha.slice(0, -1)) / 100
        : Number(alpha);
  const channels = [Number(r), Number(g), Number(b), a] as [number, number, number, number];
  return channels.every((n) => Number.isFinite(n)) ? channels : null;
}

/** A CSS colour as "#rrggbb", or "#rrggbbaa" when translucent; `alpha` scales its opacity. */
export function toHex(value: string, alpha = 1): string | null {
  const color = parseColor(value);
  if (!color) return null;
  const [r, g, b, a] = color;
  const byte = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  const opacity = a * alpha;
  const rgb = `#${byte(r)}${byte(g)}${byte(b)}`;
  return opacity >= 1 ? rgb : `${rgb}${byte(opacity * 255)}`;
}

/** Monaco's theme for the tokens `read` gives; `dark` picks the base it builds on. */
export function themeFromTokens(read: TokenReader, dark: boolean): editor.IStandaloneThemeData {
  const colors: Record<string, string> = {};
  const set = (key: string, token: string, alpha?: number) => {
    const hex = toHex(read(token), alpha);
    if (hex) colors[key] = hex;
  };
  const transparent = "#00000000";

  set("editor.background", "--panel");
  set("editor.foreground", "--ink");
  set("editorGutter.background", "--panel");
  set("editorLineNumber.foreground", "--ink-3");
  set("editorLineNumber.activeForeground", "--ink-2");
  set("editorCursor.foreground", "--ink");
  set("editor.lineHighlightBackground", "--hover");
  colors["editor.lineHighlightBorder"] = transparent;
  set("editor.selectionBackground", "--acc", 0.35);
  set("editor.inactiveSelectionBackground", "--acc", 0.2);
  set("editor.selectionHighlightBackground", "--acc", 0.16);
  set("editor.wordHighlightBackground", "--hover");
  set("editor.findMatchBackground", "--amber", 0.45);
  set("editor.findMatchHighlightBackground", "--amber", 0.22);
  set("editorWhitespace.foreground", "--line-2");
  set("editorIndentGuide.background1", "--line");
  set("editorIndentGuide.activeBackground1", "--line-2");
  set("editorBracketMatch.background", "--active");
  set("editorBracketMatch.border", "--line-2");
  set("editorOverviewRuler.border", "--line");
  set("editorRuler.foreground", "--line");
  set("editorWidget.background", "--panel-2");
  set("editorWidget.foreground", "--ink");
  set("editorWidget.border", "--line-2");
  set("editorHoverWidget.background", "--panel-2");
  set("editorHoverWidget.border", "--line-2");
  set("input.background", "--panel");
  set("input.foreground", "--ink");
  set("input.border", "--line-2");
  set("input.placeholderForeground", "--ink-3");
  set("inputOption.activeBorder", "--focus");
  set("focusBorder", "--focus");
  set("widget.shadow", "--scrim");
  set("scrollbarSlider.background", "--line-2", 0.6);
  set("scrollbarSlider.hoverBackground", "--ink-3", 0.5);
  set("scrollbarSlider.activeBackground", "--ink-3", 0.7);
  set("menu.background", "--panel");
  set("menu.foreground", "--ink");
  set("menu.border", "--line-2");
  set("menu.selectionBackground", "--active");
  set("menu.selectionForeground", "--ink");
  set("menu.separatorBackground", "--line");
  set("list.hoverBackground", "--hover");
  set("list.activeSelectionBackground", "--active");
  set("list.activeSelectionForeground", "--ink");
  set("list.focusOutline", "--focus");

  set("diffEditor.insertedLineBackground", "--add-bg");
  set("diffEditor.removedLineBackground", "--del-bg");
  set("diffEditor.insertedTextBackground", "--add-ink", 0.2);
  set("diffEditor.removedTextBackground", "--del-ink", 0.2);
  set("diffEditorGutter.insertedLineBackground", "--add-bg");
  set("diffEditorGutter.removedLineBackground", "--del-bg");
  set("diffEditorOverview.insertedForeground", "--green", 0.6);
  set("diffEditorOverview.removedForeground", "--red", 0.6);
  set("diffEditor.diagonalFill", "--line");
  set("diffEditor.border", "--line");
  set("diffEditor.unchangedRegionBackground", "--panel-2");
  set("diffEditor.unchangedRegionForeground", "--ink-3");
  set("diffEditor.unchangedCodeBackground", "--panel-2", 0.5);

  const rule = (token: string, colorToken: string, fontStyle?: string) => {
    const hex = toHex(read(colorToken));
    if (!hex) return null;
    return { token, foreground: hex.slice(1, 7), ...(fontStyle ? { fontStyle } : {}) };
  };
  const rules = [
    rule("", "--ink"),
    rule("comment", "--ink-3", "italic"),
    rule("keyword", "--blue"),
    rule("storage", "--blue"),
    rule("string", "--green"),
    rule("string.key", "--red"),
    rule("number", "--amber"),
    rule("regexp", "--amber"),
    rule("constant", "--amber"),
    rule("type", "--acc-text"),
    rule("predefined", "--acc-text"),
    rule("annotation", "--acc-text"),
    rule("metatag", "--acc-text"),
    rule("tag", "--red"),
    rule("attribute.name", "--acc-text"),
    rule("attribute.value", "--green"),
    rule("variable", "--ink"),
    rule("identifier", "--ink"),
    rule("delimiter", "--ink-2"),
    rule("operator", "--ink-2"),
    rule("keyword.md", "--blue", "bold"),
    rule("emphasis", "--ink", "italic"),
    rule("strong", "--ink", "bold"),
  ].filter((entry) => entry !== null);

  return { base: dark ? "vs-dark" : "vs", inherit: true, rules, colors };
}
