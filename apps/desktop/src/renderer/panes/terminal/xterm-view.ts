/**
 * Terminal views backed by xterm.js and its fit add-on. Loaded on demand (the first terminal),
 * so the window does not carry xterm until a shell is opened.
 *
 * Each view draws into a host element of its own; moving the host between containers keeps the
 * screen and scrollback, so a terminal survives its pane being closed and opened again.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalView, TerminalViewOptions } from "./view.ts";

/** Lines kept above the screen. */
const SCROLLBACK = 10_000;

export function createXtermView(options: TerminalViewOptions): TerminalView {
  const terminal = new Terminal({
    theme: options.theme,
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: SCROLLBACK,
    allowProposedApi: false,
    // ⌥ types the characters macOS gives it (|, {, @ on other layouts) rather than Meta.
    macOptionIsMeta: false,
    macOptionClickForcesSelection: true,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  let opened = false;

  return {
    attach(container) {
      if (host.parentElement !== container) container.appendChild(host);
      if (!opened) {
        terminal.open(host);
        opened = true;
      } else {
        terminal.refresh(0, terminal.rows - 1);
      }
    },
    detach() {
      host.remove();
    },
    write(data) {
      terminal.write(data);
    },
    fit() {
      if (!opened || !host.isConnected) return null;
      const proposed = fitAddon.proposeDimensions();
      if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) {
        return null;
      }
      const cols = Math.max(2, proposed.cols);
      const rows = Math.max(1, proposed.rows);
      if (cols === terminal.cols && rows === terminal.rows) return null;
      terminal.resize(cols, rows);
      return { cols, rows };
    },
    size() {
      return { cols: terminal.cols, rows: terminal.rows };
    },
    setTheme(theme) {
      terminal.options.theme = theme;
    },
    getSelection() {
      return terminal.getSelection();
    },
    async copySelection() {
      const text = terminal.getSelection();
      if (text === "") return false;
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Without clipboard access, the copy command reaches xterm's own copy handler.
        terminal.focus();
        return document.execCommand("copy");
      }
    },
    focus() {
      terminal.focus();
    },
    onInput(listener) {
      const subscription = terminal.onData(listener);
      return () => subscription.dispose();
    },
    onSelectionChange(listener) {
      const subscription = terminal.onSelectionChange(listener);
      return () => subscription.dispose();
    },
    dispose() {
      host.remove();
      terminal.dispose();
    },
  };
}
