/**
 * The seam between the Terminal pane and xterm.js. xterm needs a real browser (canvas, layout
 * measurements), so the pane only ever talks to a `TerminalView`; the app makes xterm ones
 * (`xterm-view.ts`) and tests pass their own through `TerminalViewContext`.
 */
import { createContext } from "react";

/** Colours for a terminal, from the theme's tokens (see theme.ts). */
export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** One terminal's screen. It keeps its content while it is not in the page. */
export interface TerminalView {
  /** Shows it in `container`, moving it there if it was elsewhere. */
  attach(container: HTMLElement): void;
  /** Takes it out of the page. */
  detach(): void;
  /** Output from the shell, escape sequences and all. */
  write(data: string): void;
  /** Fits it to its container. The new size when it changed; null when it did not or cannot. */
  fit(): TerminalSize | null;
  size(): TerminalSize;
  setTheme(theme: TerminalTheme): void;
  /** The selected text; "" when nothing is selected. */
  getSelection(): string;
  /** Copies the selection to the clipboard. False when nothing was copied. */
  copySelection(): Promise<boolean>;
  focus(): void;
  /** What the person types or pastes, as the shell should receive it. */
  onInput(listener: (data: string) => void): () => void;
  onSelectionChange(listener: () => void): () => void;
  dispose(): void;
}

export interface TerminalViewOptions {
  theme: TerminalTheme;
  fontFamily: string;
  fontSize: number;
}

/** Makes a view. May load xterm first, so it resolves when the view is ready. */
export type TerminalViewFactory = (options: TerminalViewOptions) => Promise<TerminalView>;

/** Replaces the xterm views (tests). Null: the app's own. */
export const TerminalViewContext = createContext<TerminalViewFactory | null>(null);
