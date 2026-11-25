/**
 * The browser fallback's terminal: a pretend shell that echoes what is typed and answers a few
 * commands (`pwd`, `ls`, `echo`, `clear`, `exit`), so the Terminal pane can be tried in a plain
 * browser. Output is sent asynchronously, as a real shell's would be.
 */
import {
  type DawgBridge,
  OpenTerminalInputSchema,
  SessionRefSchema,
  type TerminalDataEvent,
  type TerminalExitEvent,
  TerminalIdSchema,
  type TerminalInfo,
  TerminalInputSchema,
  TerminalSizeSchema,
  type Unsubscribe,
} from "../../shared/bridge.ts";
import { validate } from "./validate.ts";

/** What `list` keeps of each terminal's output, as main does. */
const BACKLOG_LIMIT = 256 * 1024;

interface FakeShell {
  info: TerminalInfo;
  line: string;
  backlog: string;
}

export interface FakeTerminal {
  readonly api: DawgBridge["terminal"];
  /** Test helper: the terminals still open. */
  openIds(): string[];
}

function folderName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? "/";
}

export function createFakeTerminal(): FakeTerminal {
  const shells = new Map<string, FakeShell>();
  const dataListeners = new Set<(event: TerminalDataEvent) => void>();
  const exitListeners = new Set<(event: TerminalExitEvent) => void>();
  let nextId = 1;

  function send(shell: FakeShell, data: string): void {
    shell.backlog = (shell.backlog + data).slice(-BACKLOG_LIMIT);
    const event = { terminalId: shell.info.terminalId, data };
    setTimeout(() => {
      for (const listener of [...dataListeners]) listener(event);
    }, 0);
  }

  function prompt(shell: FakeShell): string {
    return `\x1b[32m${folderName(shell.info.cwd)}\x1b[0m $ `;
  }

  function end(shell: FakeShell, exitCode: number | null, signal: number | null): void {
    shell.info.alive = false;
    shells.delete(shell.info.terminalId);
    const event = { terminalId: shell.info.terminalId, exitCode, signal };
    setTimeout(() => {
      for (const listener of [...exitListeners]) listener(event);
    }, 0);
  }

  function runCommand(shell: FakeShell, command: string): void {
    const [name = "", ...args] = command.trim().split(/\s+/);
    switch (name) {
      case "":
        break;
      case "pwd":
        send(shell, `${shell.info.cwd}\r\n`);
        break;
      case "ls":
        send(shell, "README.md  pyproject.toml  src  tests\r\n");
        break;
      case "echo":
        send(shell, `${args.join(" ")}\r\n`);
        break;
      case "clear":
        send(shell, "\x1b[2J\x1b[H");
        break;
      case "exit":
        send(shell, "exit\r\n");
        end(shell, 0, null);
        return;
      default:
        send(shell, `zsh: command not found: ${name}\r\n`);
    }
    send(shell, prompt(shell));
  }

  function type(shell: FakeShell, data: string): void {
    for (const char of data) {
      if (char === "\r" || char === "\n") {
        send(shell, "\r\n");
        const command = shell.line;
        shell.line = "";
        runCommand(shell, command);
        if (!shell.info.alive) return;
      } else if (char === "\x7f" || char === "\b") {
        if (shell.line.length > 0) {
          shell.line = shell.line.slice(0, -1);
          send(shell, "\b \b");
        }
      } else if (char === "\x03") {
        shell.line = "";
        send(shell, `^C\r\n${prompt(shell)}`);
      } else if (char >= " ") {
        shell.line += char;
        send(shell, char);
      }
    }
  }

  function shellOf(terminalId: string): FakeShell | undefined {
    return shells.get(validate(TerminalIdSchema, terminalId, "terminal"));
  }

  const api: DawgBridge["terminal"] = {
    async open(input) {
      const valid = validate(OpenTerminalInputSchema, input, "terminal");
      const terminalId = `term-${nextId++}`;
      const shell: FakeShell = {
        info: { terminalId, sessionId: valid.sessionId, cwd: valid.cwd, title: "zsh", alive: true },
        line: "",
        backlog: "",
      };
      shells.set(terminalId, shell);
      send(
        shell,
        `This is a pretend shell in the browser. It echoes what you type.\r\n${prompt(shell)}`,
      );
      return { ...shell.info };
    },
    write(terminalId, data) {
      const shell = shellOf(terminalId);
      if (shell) type(shell, validate(TerminalInputSchema, data, "terminal input"));
    },
    resize(terminalId, cols, rows) {
      validate(TerminalSizeSchema, { cols, rows }, "terminal size");
      shellOf(terminalId);
    },
    async close(terminalId) {
      const shell = shellOf(terminalId);
      if (shell) end(shell, null, 1);
    },
    async list(sessionId) {
      const id = validate(SessionRefSchema, sessionId, "session");
      return [...shells.values()]
        .filter((shell) => shell.info.sessionId === id)
        .map((shell) => ({ ...shell.info, backlog: shell.backlog }));
    },
    onData(listener): Unsubscribe {
      dataListeners.add(listener);
      return () => {
        dataListeners.delete(listener);
      };
    },
    onExit(listener): Unsubscribe {
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    },
  };

  return { api, openIds: () => [...shells.keys()] };
}
