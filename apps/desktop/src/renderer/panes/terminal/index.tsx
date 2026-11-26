/**
 * The Terminal pane: the person's own shells in the session's directory, a tab each. A shell
 * starts only when the person asks for one ("New terminal"); dawg never types here. Shells stay
 * open while the session is open, also while the pane is hidden, and a reloaded window draws
 * them again from their recent output.
 */
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ResolvedTheme } from "../../../shared/bridge.ts";
import { useNewTerminalRequests } from "../../app/commands/requests.ts";
import { run } from "../../app/run.ts";
import { getBridge } from "../../bridge/index.ts";
import { displayPath } from "../../lib/format.ts";
import { useActions, useAppStore, useAppStoreApi } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/index.ts";
import { PaneEmpty } from "../PaneEmpty.tsx";
import type { PaneProps } from "../types.ts";
import { TerminalManager, type TerminalTab, terminalManagerFor } from "./manager.ts";
import styles from "./Terminal.module.css";
import { terminalFont, terminalTheme } from "./theme.ts";
import { type TerminalView, TerminalViewContext, type TerminalViewFactory } from "./view.ts";

/** xterm is loaded with the first terminal. */
const createXtermView: TerminalViewFactory = async (options) => {
  const { createXtermView: create } = await import("./xterm-view.ts");
  return create(options);
};

/** The composer's text field, to focus after sending it a selection. */
const COMPOSER_SELECTOR = 'textarea[aria-label="Message to dawg"]';

function useTerminalManager(theme: ResolvedTheme): TerminalManager {
  const createView = useContext(TerminalViewContext) ?? createXtermView;
  const bridge = getBridge();
  return terminalManagerFor(
    bridge,
    () =>
      new TerminalManager({
        bridge,
        createView,
        theme: terminalTheme(theme),
        font: terminalFont(),
      }),
  );
}

/** "zsh", or "zsh 2" when several tabs share a name. */
function tabLabels(tabs: readonly TerminalTab[]): Map<string, string> {
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const tab of tabs) {
    const count = (seen.get(tab.title) ?? 0) + 1;
    seen.set(tab.title, count);
    labels.set(tab.terminalId, count === 1 ? tab.title : `${tab.title} ${count}`);
  }
  return labels;
}

function endedText(tab: TerminalTab): string {
  if (tab.exitCode !== null) return `This shell ended with exit code ${tab.exitCode}.`;
  if (tab.signal !== null) return `This shell ended on signal ${tab.signal}.`;
  return "This shell ended.";
}

/** Fences terminal text for the composer, with a fence longer than any backtick run in it. */
export function fenceForComposer(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text.replace(/\s+$/, "")}\n${fence}\n`;
}

export function TerminalPane({ sessionId }: PaneProps) {
  const theme = useAppStore((state) => state.resolvedTheme);
  const manager = useTerminalManager(theme);
  const terminals = useSyncExternalStore(manager.subscribe, () => manager.session(sessionId));
  const actions = useActions();
  const store = useAppStoreApi();
  // Strings, so the pane does not re-render for every event of the session.
  const cwd = useAppStore((state) => state.sessions[sessionId]?.summary.cwd ?? null);
  const projectDir = useAppStore((state) => state.sessions[sessionId]?.summary.projectDir ?? null);
  const homeDir = useAppStore((state) => state.homeDir);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    void manager.reattach(sessionId);
  }, [manager, sessionId]);

  useEffect(() => {
    manager.setTheme(terminalTheme(theme));
  }, [manager, theme]);

  const labels = useMemo(() => tabLabels(terminals.tabs), [terminals.tabs]);
  const active =
    terminals.tabs.find((tab) => tab.terminalId === terminals.selectedId) ??
    terminals.tabs.at(-1) ??
    null;

  const focusNext = useRef(false);
  const openTerminal = useCallback(async () => {
    if (cwd === null) return;
    setOpening(true);
    setError(null);
    try {
      // Main opens shells only in a tracked session's directories.
      await actions.trackSession(sessionId);
      focusNext.current = true;
      await manager.open(sessionId, cwd);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(`Could not open a terminal: ${message.replace(/\.$/, "")}.`);
    } finally {
      setOpening(false);
    }
  }, [actions, cwd, manager, sessionId]);

  // "New terminal" from the command palette.
  useNewTerminalRequests(sessionId, () => run(openTerminal()));

  const sendToComposer = useCallback(
    (text: string) => {
      if (text.trim() === "") return;
      const draft = store.getState().ui.drafts[sessionId] ?? "";
      const block = fenceForComposer(text);
      actions.setDraft(
        sessionId,
        draft.trim() === "" ? block : `${draft.replace(/\s+$/, "")}\n\n${block}`,
      );
      document
        .querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR)
        ?.focus({ preventScroll: true });
    },
    [actions, sessionId, store],
  );

  if (terminals.tabs.length === 0) {
    return (
      <PaneEmpty pane="terminal" title="No terminal open">
        <p className={styles.emptyText}>
          Your own shell in the session’s folder. dawg sees only what you send it, and never types
          here.
        </p>
        <Button
          variant="primary"
          icon="terminal"
          disabled={opening || cwd === null}
          onClick={() => run(openTerminal())}
        >
          New terminal
        </Button>
        {error !== null && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </PaneEmpty>
    );
  }

  return (
    <div className={styles.pane}>
      <div className={styles.bar}>
        <div className={styles.tabs}>
          {terminals.tabs.map((tab) => {
            const label = labels.get(tab.terminalId) ?? tab.title;
            const selected = tab.terminalId === active?.terminalId;
            return (
              <span key={tab.terminalId} className={styles.tab} data-selected={selected}>
                <button
                  type="button"
                  className={styles.tabButton}
                  aria-pressed={selected}
                  aria-label={tab.alive ? label : `${label}, ended`}
                  onClick={() => {
                    focusNext.current = true;
                    manager.select(sessionId, tab.terminalId);
                  }}
                >
                  {label}
                  {!tab.alive && <span className={styles.endedMark}> · ended</span>}
                </button>
                <IconButton
                  icon="close"
                  size="sm"
                  className={styles.tabClose}
                  label={`Close ${label}`}
                  onClick={() => run(manager.close(tab.terminalId))}
                />
              </span>
            );
          })}
        </div>
        <IconButton
          icon="plus"
          size="sm"
          label="New terminal"
          disabled={opening || cwd === null}
          onClick={() => run(openTerminal())}
        />
        <span className={styles.grow} />
        {active && (
          <span className={styles.cwd} title={active.cwd}>
            {displayPath(active.cwd, projectDir ?? active.cwd, homeDir)}
          </span>
        )}
      </div>
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {active && (
        <TerminalScreen
          key={active.terminalId}
          manager={manager}
          tab={active}
          label={labels.get(active.terminalId) ?? active.title}
          focusNext={focusNext}
          onSendSelection={sendToComposer}
          onClose={() => run(manager.close(active.terminalId))}
          onNew={() => run(openTerminal())}
        />
      )}
    </div>
  );
}

function TerminalScreen(props: {
  manager: TerminalManager;
  tab: TerminalTab;
  label: string;
  focusNext: { current: boolean };
  onSendSelection(text: string): void;
  onClose(): void;
  onNew(): void;
}) {
  const { manager, tab, focusNext } = props;
  const containerRef = useRef<HTMLElement>(null);
  const [view, setView] = useState<TerminalView | null>(null);
  const [hasSelection, setHasSelection] = useState(false);

  // Shows the tab's screen here; it leaves the page (keeping its content) when this unmounts.
  useEffect(() => {
    let cancelled = false;
    let shown: TerminalView | null = null;
    void manager.view(tab.terminalId).then((ready) => {
      const container = containerRef.current;
      if (cancelled || !ready || !container) return;
      ready.attach(container);
      shown = ready;
      setView(ready);
      const size = ready.fit() ?? ready.size();
      manager.resize(tab.terminalId, size);
      if (focusNext.current) {
        focusNext.current = false;
        ready.focus();
      }
    });
    return () => {
      cancelled = true;
      shown?.detach();
    };
  }, [manager, tab.terminalId, focusNext]);

  // Follows the pane's size.
  useEffect(() => {
    const container = containerRef.current;
    if (!view || !container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const size = view.fit();
      if (size) manager.resize(tab.terminalId, size);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [manager, view, tab.terminalId]);

  useEffect(() => {
    if (!view) return;
    setHasSelection(view.getSelection() !== "");
    return view.onSelectionChange(() => setHasSelection(view.getSelection() !== ""));
  }, [view]);

  // Esc belongs to the shell (and the programs in it), not to the window's "stop dawg".
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.stopPropagation();
    };
    container.addEventListener("keydown", onKeyDown);
    return () => container.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <section
        ref={containerRef}
        className={styles.screen}
        aria-label={`Terminal ${props.label}`}
      />
      {!tab.alive && (
        <div className={styles.ended} role="status">
          <span className={styles.grow}>{endedText(tab)}</span>
          <Button size="sm" onClick={props.onClose}>
            Close the tab
          </Button>
          <Button size="sm" variant="primary" onClick={props.onNew}>
            New terminal
          </Button>
        </div>
      )}
      <div className={styles.footer}>
        <span className={styles.hint}>
          Your own shell: dawg sees only what you send it. ⌘C copies, ⌘V pastes.
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={!hasSelection}
          onClick={() => run(view?.copySelection() ?? Promise.resolve(false))}
        >
          Copy
        </Button>
        <Button
          size="sm"
          disabled={!hasSelection}
          onClick={() => props.onSendSelection(view?.getSelection() ?? "")}
        >
          Send selection to the composer
        </Button>
      </div>
    </>
  );
}
