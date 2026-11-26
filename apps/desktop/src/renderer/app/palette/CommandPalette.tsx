/**
 * The command palette (⌘K): every action that applies now and every session, in one searchable
 * list. A modal dialog holding a combobox: focus stays in the search field, which moves through
 * the listbox with aria-activedescendant (↑ ↓, Home, End, Page Up, Page Down) and runs the row
 * with ⏎. Esc closes it and focus goes back where it was. Mounted once, by the app's root, so it
 * opens from any view.
 */
import type { SessionId } from "@dawg/protocol";
import { Dialog } from "radix-ui";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { StatusMark } from "../../sidebar/StatusMark.tsx";
import { selectTitleBar } from "../../state/selectors.ts";
import { type AppStoreApi, useAppStoreApi } from "../../state/store.ts";
import { ConfirmDialog, Icon, Kbd } from "../../ui/index.ts";
import { commandContext } from "../commands/dispatch.ts";
import { formatShortcut, isComposing, matchesShortcut, spokenShortcut } from "../commands/keys.ts";
import { availability } from "../commands/registry.ts";
import { SHORTCUTS } from "../commands/shortcuts.ts";
import { type PlatformOs, usePlatformOs } from "../platform.tsx";
import { run } from "../run.ts";
import styles from "./CommandPalette.module.css";
import { type PaletteController, paletteFor, usePaletteSnapshot } from "./controller.ts";
import {
  buildSource,
  isSessionWorking,
  type PaletteRow,
  type PaletteSection,
  paletteSections,
} from "./items.ts";
import { recentCommandIds, rememberCommand } from "./recent.ts";

/** Rows Page Up and Page Down move by. */
const PAGE = 8;

/** The composer's text field: where focus goes after opening a session. */
const COMPOSER_SELECTOR = 'textarea[aria-label="Message to dawg"]';

/**
 * Where focus goes when what had it before the palette is gone (the action changed the view):
 * the message field, or the page Settings shows.
 */
const FALLBACK_FOCUS = `${COMPOSER_SELECTOR}, nav [aria-current="page"]`;

function nothingFocused(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

export function CommandPalette() {
  const store = useAppStoreApi();
  const os = usePlatformOs();
  const controller = paletteFor(store);
  const snapshot = usePaletteSnapshot(controller);
  const { view } = snapshot;

  return (
    <>
      <Dialog.Root
        open={view.kind !== "closed"}
        onOpenChange={(open) => {
          if (!open) controller.close();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content
            className={styles.palette}
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              const back = controller.takeFocusBefore();
              // Radix would try the element that had focus at opening even when it has gone.
              event.preventDefault();
              if (back) back.focus({ preventScroll: true });
              else if (nothingFocused()) {
                document.querySelector<HTMLElement>(FALLBACK_FOCUS)?.focus({ preventScroll: true });
              }
              controller.flush();
            }}
          >
            {view.kind === "rename" ? (
              <RenameStep store={store} controller={controller} sessionId={view.sessionId} />
            ) : (
              <PaletteList store={store} os={os} controller={controller} />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <DeleteConfirmation store={store} controller={controller} sessionId={snapshot.deleting} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------

function PaletteList(props: { store: AppStoreApi; os: PlatformOs; controller: PaletteController }) {
  const { store, os, controller } = props;
  // What the palette lists is fixed when it opens: following the store would redraw it for every
  // streamed token. A row's action checks the state again when it runs.
  const [source] = useState(() => buildSource(store.getState(), Date.now()));
  const [recent] = useState(recentCommandIds);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const idPrefix = useId();
  const optionId = (key: string) => `${idPrefix}-${key}`;

  const sections = useMemo(() => paletteSections(source, query, recent), [source, query, recent]);
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const current = rows[Math.min(active, rows.length - 1)] ?? null;

  const activeId = current ? optionId(current.key) : undefined;
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const choose = (row: PaletteRow) => {
    if (row.kind === "session") {
      openSession(store, controller, row.sessionId);
      return;
    }
    const context = commandContext(store, os);
    if (row.disabled !== null || availability(row.command, context.state) !== true) return;
    rememberCommand(row.command.id);
    row.command.run?.(context);
    // An action that shows something else in the palette (rename) keeps it open.
    if (controller.getSnapshot().view.kind === "list") controller.close();
  };

  const move = (index: number) => {
    if (rows.length > 0) setActive(Math.max(0, Math.min(rows.length - 1, index)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // ⏎ that ends an IME composition is the IME's, not a choice.
    if (isComposing(event.nativeEvent)) return;
    if (matchesShortcut(event, SHORTCUTS.palette, os)) {
      event.preventDefault();
      controller.close();
      return;
    }
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    const index = current ? rows.indexOf(current) : 0;
    let handled = true;
    if (event.key === "ArrowDown" && plain) setActive((index + 1) % Math.max(rows.length, 1));
    else if (event.key === "ArrowUp" && plain)
      setActive((index - 1 + rows.length) % Math.max(rows.length, 1));
    else if (event.key === "Home" && plain) move(0);
    else if (event.key === "End" && plain) move(rows.length - 1);
    else if (event.key === "PageDown" && plain) move(index + PAGE);
    else if (event.key === "PageUp" && plain) move(index - PAGE);
    else if (event.key === "Enter" && plain && current) choose(current);
    else handled = false;
    if (handled) event.preventDefault();
  };

  const trimmed = query.trim();
  return (
    <>
      <Dialog.Title className="vh">Command palette</Dialog.Title>
      <div className={styles.search}>
        <Icon name="search" size={16} className={styles.searchIcon} />
        <input
          className={styles.input}
          role="combobox"
          aria-label="Search actions and sessions"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          placeholder="Search actions and sessions"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div id={listId} role="listbox" aria-label="Actions and sessions" className={styles.list}>
        {sections.map((section) => (
          <Section
            key={section.heading}
            section={section}
            os={os}
            activeKey={current?.key ?? null}
            optionId={optionId}
            onHover={(row) => setActive(rows.indexOf(row))}
            onChoose={choose}
          />
        ))}
      </div>
      {rows.length === 0 && (
        <p className={styles.empty} role="status">
          {trimmed === ""
            ? "Nothing to do here yet."
            : `No actions or sessions match “${trimmed}”.`}
        </p>
      )}
    </>
  );
}

function Section(props: {
  section: PaletteSection;
  os: PlatformOs;
  activeKey: string | null;
  optionId(key: string): string;
  onHover(row: PaletteRow): void;
  onChoose(row: PaletteRow): void;
}) {
  const headingId = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of options in a listbox, not form fields
    <div role="group" aria-labelledby={headingId} className={styles.section}>
      <div id={headingId} className={styles.heading} role="presentation">
        {props.section.heading}
      </div>
      {props.section.rows.map((row) => (
        <Row
          key={row.key}
          row={row}
          os={props.os}
          id={props.optionId(row.key)}
          active={row.key === props.activeKey}
          onHover={() => props.onHover(row)}
          onChoose={() => props.onChoose(row)}
        />
      ))}
    </div>
  );
}

/** What VoiceOver reads for a row, in one sentence. */
function rowLabel(row: PaletteRow, os: PlatformOs): string {
  if (row.kind === "session") {
    const parts = [row.title, row.markLabel, row.detail];
    if (row.current) parts.push("open now");
    return parts.filter(Boolean).join(", ");
  }
  const parts = [row.title];
  if (row.checked) parts.push("in use");
  if (row.disabled) parts.push(`unavailable: ${row.disabled}`);
  if (row.shortcut) parts.push(spokenShortcut(row.shortcut, os));
  return parts.join(", ");
}

function Row(props: {
  row: PaletteRow;
  os: PlatformOs;
  id: string;
  active: boolean;
  onHover(): void;
  onChoose(): void;
}) {
  const { row } = props;
  const disabled = row.kind === "command" && row.disabled !== null;
  return (
    <div
      id={props.id}
      role="option"
      aria-selected={props.active}
      aria-disabled={disabled || undefined}
      aria-label={rowLabel(row, props.os)}
      tabIndex={-1}
      className={styles.row}
      data-active={props.active ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
      // Moving, not entering: a list scrolled under a still pointer must not move the selection.
      onMouseMove={() => {
        if (!props.active) props.onHover();
      }}
      // Mouse down, not click: choosing must not take focus from the search field.
      onMouseDown={(event) => {
        event.preventDefault();
        if (event.button === 0) props.onChoose();
      }}
    >
      {row.kind === "session" ? (
        <StatusMark mark={row.mark} label={row.markLabel} />
      ) : (
        <span className={styles.check} aria-hidden="true">
          {row.checked && <Icon name="check" size={14} />}
        </span>
      )}
      <span className={styles.title}>{row.title}</span>
      {row.detail !== null && <span className={styles.detail}>{row.detail}</span>}
      {row.kind === "session" && row.current && <span className={styles.detail}>Open now</span>}
      {row.kind === "command" && row.shortcut && (
        <Kbd className={styles.kbd}>{formatShortcut(row.shortcut, props.os)}</Kbd>
      )}
    </div>
  );
}

function openSession(store: AppStoreApi, controller: PaletteController, id: SessionId): void {
  const { actions, layout } = store.getState();
  actions.selectSession(id);
  if (layout.view !== "sessions") actions.setView("sessions");
  controller.whenClosed(() => {
    // The session's message field, unless something in the session (a decision card) took focus
    // when it appeared.
    setTimeout(() => {
      if (document.activeElement?.closest("main")) return;
      document.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR)?.focus();
    }, 0);
  });
}

// ---------------------------------------------------------------------------------------------
// Rename and delete
// ---------------------------------------------------------------------------------------------

function sessionTitle(store: AppStoreApi, id: SessionId): string {
  const state = store.getState();
  const session = state.sessions[id];
  if (session) return session.summary.title ?? "New session";
  const titleBar = selectTitleBar(state);
  return titleBar.sessionId === id ? titleBar.title : "New session";
}

function RenameStep(props: {
  store: AppStoreApi;
  controller: PaletteController;
  sessionId: SessionId;
}) {
  const { store, controller, sessionId } = props;
  const [title] = useState(() => sessionTitle(store, sessionId));
  const [value, setValue] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  return (
    <form
      className={styles.renameForm}
      onSubmit={(event) => {
        event.preventDefault();
        const next = value.trim();
        if (next !== "" && next !== title) {
          run(store.getState().actions.renameSession(sessionId, next));
        }
        controller.close();
      }}
    >
      <Dialog.Title className={styles.stepTitle}>Rename “{title}”</Dialog.Title>
      <input
        ref={input}
        className={`${styles.input} ${styles.renameInput}`}
        aria-label="Session title"
        aria-describedby={hintId}
        autoComplete="off"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <p id={hintId} className={styles.stepHint}>
        ⏎ saves the title. Esc leaves it as it is.
      </p>
    </form>
  );
}

function DeleteConfirmation(props: {
  store: AppStoreApi;
  controller: PaletteController;
  sessionId: SessionId | null;
}) {
  const { store, controller, sessionId } = props;
  // Kept while the dialog closes, so its text does not change on the way out.
  const shown = useRef<{ id: SessionId; title: string; working: boolean } | null>(null);
  if (sessionId !== null && shown.current?.id !== sessionId) {
    shown.current = {
      id: sessionId,
      title: sessionTitle(store, sessionId),
      working: isSessionWorking(store.getState(), sessionId),
    };
  }
  const details = shown.current;
  if (details === null) return null;
  return (
    <ConfirmDialog
      open={sessionId !== null}
      onOpenChange={(open) => {
        if (!open) controller.endDelete();
      }}
      title={`Delete “${details.title}”?`}
      confirmLabel="Delete"
      destructive
      onConfirm={() => run(store.getState().actions.deleteSession(details.id))}
    >
      <p>The session and its transcript are deleted for good. This cannot be undone.</p>
      {details.working && <p>dawg is working in it: the running turn stops first.</p>}
    </ConfirmDialog>
  );
}
