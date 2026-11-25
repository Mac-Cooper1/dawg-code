/**
 * The Terminal pane's shells (`terminal` in the bridge). Each terminal is one pseudo-terminal
 * running the person's login shell in one of a session's folders. They belong to the person: only
 * an explicit action opens one, and the agent never types here.
 *
 * Output is batched (about one message per frame) and the last ~256 KB of each terminal is kept,
 * so a reloaded window can redraw what it showed. Every shell ends when the app quits.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  OpenTerminalInput,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalInfo,
  TerminalReattach,
  Unsubscribe,
} from "../../shared/bridge.ts";

/** The slice of node-pty's `IPty` the service uses (a fake in tests). */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name: string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export type SpawnPty = (
  file: string,
  args: string[],
  options: PtySpawnOptions,
) => Promise<PtyProcess>;

export interface TerminalServiceOptions {
  spawn: SpawnPty;
  /** Checks a folder is inside a tracked session's folders (throws when it is not). */
  resolveDirectory(sessionId: string, dir: string): Promise<{ real: string; logical: string }>;
  log: (message: string) => void;
  /** The environment shells start from (the app's own, by default). */
  env?: NodeJS.ProcessEnv;
  /** How long output collects before it is sent (about one frame). */
  flushMs?: number;
  /** How much recent output each terminal keeps, in characters. */
  backlogChars?: number;
}

export interface TerminalService {
  open(input: OpenTerminalInput): Promise<TerminalInfo>;
  write(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  close(terminalId: string): Promise<void>;
  list(sessionId: string): TerminalReattach[];
  onData(listener: (event: TerminalDataEvent) => void): Unsubscribe;
  onExit(listener: (event: TerminalExitEvent) => void): Unsubscribe;
  /** Ends every shell (the app is quitting). */
  disposeAll(): void;
}

interface Terminal {
  info: TerminalInfo;
  pty: PtyProcess;
  /** Recent output, oldest first. */
  backlog: string[];
  backlogLength: number;
  pending: string[];
  timer: NodeJS.Timeout | null;
}

const DEFAULT_BACKLOG_CHARS = 256 * 1024;

/** The person's login shell: `$SHELL` when it is an absolute path, else zsh. */
export function loginShell(env: NodeJS.ProcessEnv): string {
  const shell = env.SHELL;
  return shell !== undefined && path.isAbsolute(shell) ? shell : "/bin/zsh";
}

/**
 * What a shell starts with: the app's environment without Electron's own variables, a terminal
 * type xterm.js understands, and UTF-8 when nothing chose a locale (apps opened from the Finder
 * get none).
 */
export function shellEnv(base: NodeJS.ProcessEnv, cwd: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key.startsWith("ELECTRON_")) continue;
    env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.PWD = cwd;
  if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = "en_US.UTF-8";
  return env;
}

export function createTerminalService(options: TerminalServiceOptions): TerminalService {
  const { spawn, log } = options;
  const flushMs = options.flushMs ?? 16;
  const backlogChars = options.backlogChars ?? DEFAULT_BACKLOG_CHARS;
  const terminals = new Map<string, Terminal>();
  const dataListeners = new Set<(event: TerminalDataEvent) => void>();
  const exitListeners = new Set<(event: TerminalExitEvent) => void>();

  function notify<T>(listeners: Set<(event: T) => void>, event: T): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        log(
          `A terminal listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  function remember(terminal: Terminal, data: string): void {
    terminal.backlog.push(data);
    terminal.backlogLength += data.length;
    // Typing echoes a character at a time; keep the list of pieces short.
    if (terminal.backlog.length > 1024) terminal.backlog = [terminal.backlog.join("")];
    while (terminal.backlogLength > backlogChars && terminal.backlog.length > 0) {
      const excess = terminal.backlogLength - backlogChars;
      const first = terminal.backlog[0] ?? "";
      if (first.length <= excess) {
        terminal.backlog.shift();
        terminal.backlogLength -= first.length;
      } else {
        terminal.backlog[0] = first.slice(excess);
        terminal.backlogLength -= excess;
      }
    }
  }

  function flush(terminal: Terminal): void {
    if (terminal.timer !== null) clearTimeout(terminal.timer);
    terminal.timer = null;
    if (terminal.pending.length === 0) return;
    const data = terminal.pending.join("");
    terminal.pending = [];
    notify(dataListeners, { terminalId: terminal.info.terminalId, data });
  }

  /** The backlog, starting at a line when one begins soon after the cut. */
  function backlogOf(terminal: Terminal): string {
    const text = terminal.backlog.join("");
    if (terminal.backlogLength < backlogChars) return text;
    const newline = text.indexOf("\n");
    return newline !== -1 && newline < 4096 ? text.slice(newline + 1) : text;
  }

  function end(terminal: Terminal, signal: string): void {
    try {
      terminal.pty.kill(signal);
    } catch (error) {
      log(`Could not end terminal ${terminal.info.terminalId}: ${(error as Error).message}`);
    }
  }

  return {
    async open(input) {
      const dir = await options.resolveDirectory(input.sessionId, input.cwd);
      const env = options.env ?? process.env;
      const shell = loginShell(env);
      const pty = await spawn(shell, ["-l"], {
        name: "xterm-256color",
        cwd: dir.logical,
        env: shellEnv(env, dir.logical),
        cols: input.cols,
        rows: input.rows,
      });
      const terminalId = randomUUID();
      const terminal: Terminal = {
        info: {
          terminalId,
          sessionId: input.sessionId,
          cwd: dir.logical,
          title: path.basename(shell),
          alive: true,
        },
        pty,
        backlog: [],
        backlogLength: 0,
        pending: [],
        timer: null,
      };
      terminals.set(terminalId, terminal);
      pty.onData((data) => {
        if (terminals.get(terminalId) !== terminal) return;
        remember(terminal, data);
        terminal.pending.push(data);
        terminal.timer ??= setTimeout(() => flush(terminal), flushMs);
      });
      pty.onExit(({ exitCode, signal }) => {
        terminal.info.alive = false;
        if (terminals.get(terminalId) !== terminal) return;
        flush(terminal);
        const bySignal = signal !== undefined && signal > 0;
        notify(exitListeners, {
          terminalId,
          exitCode: bySignal && exitCode === 0 ? null : exitCode,
          signal: bySignal ? signal : null,
        });
      });
      log(`Opened terminal ${terminalId} (${shell}, pid ${pty.pid}) in ${dir.logical}.`);
      return { ...terminal.info };
    },

    write(terminalId, data) {
      const terminal = terminals.get(terminalId);
      if (!terminal?.info.alive) return;
      terminal.pty.write(data);
    },

    resize(terminalId, cols, rows) {
      const terminal = terminals.get(terminalId);
      if (!terminal?.info.alive) return;
      try {
        terminal.pty.resize(cols, rows);
      } catch (error) {
        log(`Could not resize terminal ${terminalId}: ${(error as Error).message}`);
      }
    },

    async close(terminalId) {
      const terminal = terminals.get(terminalId);
      if (!terminal) return;
      terminals.delete(terminalId);
      if (terminal.timer !== null) clearTimeout(terminal.timer);
      // SIGHUP, as when a terminal window closes: the shell passes it on to its jobs.
      if (terminal.info.alive) end(terminal, "SIGHUP");
    },

    list(sessionId) {
      return [...terminals.values()]
        .filter((terminal) => terminal.info.sessionId === sessionId)
        .map((terminal) => ({ ...terminal.info, backlog: backlogOf(terminal) }));
    },

    onData(listener) {
      dataListeners.add(listener);
      return () => {
        dataListeners.delete(listener);
      };
    },

    onExit(listener) {
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    },

    disposeAll() {
      for (const terminal of terminals.values()) {
        if (terminal.timer !== null) clearTimeout(terminal.timer);
        if (terminal.info.alive) end(terminal, "SIGHUP");
      }
      terminals.clear();
    },
  };
}
