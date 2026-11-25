/**
 * The window's terminals, kept outside React so they live while their session is open even when
 * the pane is hidden or closed: main keeps the shells, and the manager keeps their screens
 * (`TerminalView`s) and writes the shells' output to them as it arrives.
 *
 * A reloaded window starts with no screens: `reattach` asks main for the session's terminals and
 * redraws each from its backlog. One manager per bridge (`terminalManagerFor`).
 */
import type { SessionId } from "@dawg/protocol";
import type { DawgBridge, TerminalInfo, Unsubscribe } from "../../../shared/bridge.ts";
import type { TerminalSize, TerminalTheme, TerminalView, TerminalViewFactory } from "./view.ts";

/** Output kept for a screen that is still being made. */
const MAX_PENDING = 512 * 1024;
const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

export interface TerminalTab {
  terminalId: string;
  sessionId: SessionId;
  cwd: string;
  /** The shell's name ("zsh"). */
  title: string;
  /** False once the shell has ended. */
  alive: boolean;
  exitCode: number | null;
  signal: number | null;
}

export interface SessionTerminals {
  /** In the order they were opened. */
  tabs: readonly TerminalTab[];
  /** The tab shown; null when there are none. */
  selectedId: string | null;
  /** Main has been asked which terminals the session has. */
  listed: boolean;
}

interface Entry {
  tab: TerminalTab;
  view: TerminalView | null;
  ready: Promise<TerminalView | null>;
  /** Output that arrived before the view was ready. */
  pending: string;
  disposed: boolean;
  stopInput: (() => void) | null;
}

const EMPTY: SessionTerminals = Object.freeze({ tabs: [], selectedId: null, listed: false });

export interface TerminalManagerOptions {
  bridge: Pick<DawgBridge, "terminal">;
  createView: TerminalViewFactory;
  theme: TerminalTheme;
  font: { fontFamily: string; fontSize: number };
}

export class TerminalManager {
  private readonly bridge: Pick<DawgBridge, "terminal">;
  private readonly createView: TerminalViewFactory;
  private readonly font: { fontFamily: string; fontSize: number };
  private theme: TerminalTheme;
  private readonly entries = new Map<string, Entry>();
  private readonly sessions = new Map<SessionId, SessionTerminals>();
  private readonly listeners = new Set<() => void>();
  private readonly stopEvents: Unsubscribe[] = [];
  private lastSize: TerminalSize = DEFAULT_SIZE;

  constructor(options: TerminalManagerOptions) {
    this.bridge = options.bridge;
    this.createView = options.createView;
    this.theme = options.theme;
    this.font = options.font;
    try {
      this.stopEvents.push(
        this.bridge.terminal.onData((event) => this.output(event.terminalId, event.data)),
        this.bridge.terminal.onExit((event) =>
          this.ended(event.terminalId, event.exitCode, event.signal),
        ),
      );
    } catch {
      // A bridge without terminals (an older main): opening one fails and says so.
    }
  }

  // --- For React (useSyncExternalStore) ------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  session(sessionId: SessionId): SessionTerminals {
    return this.sessions.get(sessionId) ?? EMPTY;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private update(sessionId: SessionId, change: (current: SessionTerminals) => SessionTerminals) {
    const current = this.session(sessionId);
    const next = change(current);
    if (next === current) return;
    this.sessions.set(sessionId, next);
    this.emit();
  }

  private patchTab(terminalId: string, patch: Partial<TerminalTab>): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    entry.tab = { ...entry.tab, ...patch };
    const tab = entry.tab;
    this.update(tab.sessionId, (current) => ({
      ...current,
      tabs: current.tabs.map((candidate) =>
        candidate.terminalId === terminalId ? tab : candidate,
      ),
    }));
  }

  // --- Terminals -------------------------------------------------------------------------------

  /**
   * Asks main for the session's open terminals and adds those this window has no screen for,
   * drawing their recent output. Terminals main no longer has leave the list.
   */
  async reattach(sessionId: SessionId): Promise<void> {
    const knownBefore = new Set(this.session(sessionId).tabs.map((tab) => tab.terminalId));
    let list: Awaited<ReturnType<DawgBridge["terminal"]["list"]>>;
    try {
      list = await this.bridge.terminal.list(sessionId);
    } catch {
      this.update(sessionId, (current) =>
        current.listed ? current : { ...current, listed: true },
      );
      return;
    }
    const listed = new Set(list.map((terminal) => terminal.terminalId));
    for (const id of knownBefore) {
      if (!listed.has(id)) this.forget(id);
    }
    for (const terminal of list) {
      const entry = this.entries.get(terminal.terminalId);
      if (entry) {
        if (entry.tab.alive && !terminal.alive)
          this.patchTab(terminal.terminalId, { alive: false });
        continue;
      }
      this.add(terminal, terminal.backlog);
    }
    this.update(sessionId, (current) => (current.listed ? current : { ...current, listed: true }));
  }

  /** Starts a shell in `cwd` for the session and shows it. Rejects with main's reason. */
  async open(sessionId: SessionId, cwd: string): Promise<TerminalTab> {
    const { cols, rows } = this.lastSize;
    const info = await this.bridge.terminal.open({ sessionId, cwd, cols, rows });
    const entry = this.add(info, "");
    this.select(sessionId, info.terminalId);
    return entry.tab;
  }

  /** Ends the shell (if it still runs) and drops its tab. */
  async close(terminalId: string): Promise<void> {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    try {
      await this.bridge.terminal.close(terminalId);
    } catch {
      // Already gone in main: the tab goes all the same.
    }
    this.forget(terminalId);
  }

  select(sessionId: SessionId, terminalId: string): void {
    this.update(sessionId, (current) =>
      current.selectedId === terminalId ? current : { ...current, selectedId: terminalId },
    );
  }

  /** The tab's screen, once it is ready. Null for a tab that is gone. */
  view(terminalId: string): Promise<TerminalView | null> {
    return this.entries.get(terminalId)?.ready ?? Promise.resolve(null);
  }

  /** Tells the shell its new size (after the pane fitted the screen). */
  resize(terminalId: string, size: TerminalSize): void {
    this.lastSize = size;
    const entry = this.entries.get(terminalId);
    if (!entry?.tab.alive) return;
    try {
      this.bridge.terminal.resize(terminalId, size.cols, size.rows);
    } catch {
      // The shell is going away; nothing to resize.
    }
  }

  setTheme(theme: TerminalTheme): void {
    this.theme = theme;
    for (const entry of this.entries.values()) entry.view?.setTheme(theme);
  }

  /** Ends every screen (window teardown, tests). The shells stay with main. */
  dispose(): void {
    for (const stop of this.stopEvents.splice(0)) stop();
    for (const id of [...this.entries.keys()]) this.forget(id);
  }

  // --- Internals -------------------------------------------------------------------------------

  private add(info: TerminalInfo, backlog: string): Entry {
    const tab: TerminalTab = {
      terminalId: info.terminalId,
      sessionId: info.sessionId,
      cwd: info.cwd,
      title: info.title,
      alive: info.alive,
      exitCode: null,
      signal: null,
    };
    const entry: Entry = {
      tab,
      view: null,
      ready: Promise.resolve(null),
      pending: backlog,
      disposed: false,
      stopInput: null,
    };
    entry.ready = this.createView({ theme: this.theme, ...this.font }).then(
      (view) => {
        if (entry.disposed) {
          view.dispose();
          return null;
        }
        entry.view = view;
        view.setTheme(this.theme);
        if (entry.pending !== "") view.write(entry.pending);
        entry.pending = "";
        entry.stopInput = view.onInput((data) => {
          if (!entry.tab.alive) return;
          try {
            this.bridge.terminal.write(entry.tab.terminalId, data);
          } catch {
            // The shell has gone; its exit event marks the tab.
          }
        });
        return view;
      },
      () => null,
    );
    this.entries.set(info.terminalId, entry);
    this.update(info.sessionId, (current) => ({
      ...current,
      tabs: [...current.tabs, tab],
      selectedId: current.selectedId ?? tab.terminalId,
    }));
    return entry;
  }

  private forget(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    entry.disposed = true;
    entry.stopInput?.();
    entry.view?.dispose();
    this.entries.delete(terminalId);
    const { sessionId } = entry.tab;
    this.update(sessionId, (current) => {
      const index = current.tabs.findIndex((tab) => tab.terminalId === terminalId);
      const tabs = current.tabs.filter((tab) => tab.terminalId !== terminalId);
      const neighbour = tabs[Math.min(index, tabs.length - 1)] ?? null;
      return {
        ...current,
        tabs,
        selectedId:
          current.selectedId === terminalId ? (neighbour?.terminalId ?? null) : current.selectedId,
      };
    });
  }

  private output(terminalId: string, data: string): void {
    const entry = this.entries.get(terminalId);
    // Output for a terminal this window has no tab for yet arrives with its backlog instead.
    if (!entry) return;
    if (entry.view) {
      entry.view.write(data);
      return;
    }
    entry.pending += data;
    if (entry.pending.length > MAX_PENDING) entry.pending = entry.pending.slice(-MAX_PENDING);
  }

  private ended(terminalId: string, exitCode: number | null, signal: number | null): void {
    this.patchTab(terminalId, { alive: false, exitCode, signal });
  }
}

const managers = new WeakMap<object, TerminalManager>();

/** The manager for a bridge, made on first use. */
export function terminalManagerFor(
  bridge: Pick<DawgBridge, "terminal">,
  make: () => TerminalManager,
): TerminalManager {
  let manager = managers.get(bridge);
  if (!manager) {
    manager = make();
    managers.set(bridge, manager);
  }
  return manager;
}
