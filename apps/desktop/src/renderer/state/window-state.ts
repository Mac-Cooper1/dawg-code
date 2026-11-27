/**
 * What a window remembers between launches (layout, selection, seen marks, and what the person
 * typed and has not sent), and the debounced save through the bridge. Dragging a splitter fires
 * dozens of changes a second, typing one a keystroke; one save follows the last of them.
 *
 * Unsent words survive a quit: each session's draft (with the paths its `@` menu inserted) and its
 * queued and held messages (text and mentions). Images are not saved, only how many there were,
 * so the composer can say they were not kept. A queued message comes back held: nothing is sent
 * after a relaunch without the person asking.
 */
import {
  type DawgBridge,
  DOCK_WIDTH,
  type SavedComposer,
  type SavedMessage,
  SIDEBAR_WIDTH,
  type WindowState,
} from "../../shared/bridge.ts";
import type { AppState, Layout, QueuedMessage, UiState } from "./types.ts";

export const SAVE_DELAY_MS = 500;
/**
 * The longest a change waits to be saved. While a session streams, the state changes every frame
 * (its seen mark follows the reply), so a plain debounce would never save until the reply ends;
 * a message queued meanwhile would be lost to a quit.
 */
export const SAVE_MAX_WAIT_MS = 2000;

export function windowStateOf(state: Pick<AppState, "layout" | "ui">): WindowState {
  const { layout, ui } = state;
  return {
    sidebarOpen: layout.sidebarOpen,
    sidebarWidth: layout.sidebarWidth,
    dockOpen: layout.dockOpen,
    dockPane: layout.dockPane,
    dockWidth: layout.dockWidth,
    selectedSessionId: layout.selectedSessionId,
    seenSeq: ui.seenSeq,
    composers: composersOf(ui),
  };
}

function savedMessage(message: QueuedMessage): SavedMessage {
  return {
    text: message.text,
    mentions: message.mentions ?? [],
    imagesNotKept: (message.images?.length ?? 0) + (message.imagesNotKept ?? 0),
  };
}

/** Each session's unsent words, leaving out sessions with none. */
export function composersOf(
  ui: Pick<UiState, "drafts" | "mentionPaths" | "attachments" | "queues" | "draftImagesNotKept">,
): Record<string, SavedComposer> {
  const ids = new Set([...Object.keys(ui.drafts), ...Object.keys(ui.queues)]);
  const composers: Record<string, SavedComposer> = {};
  for (const id of ids) {
    const draft = ui.drafts[id] ?? "";
    // A message of images alone has no words to keep.
    const queue = (ui.queues[id] ?? [])
      .filter((message) => message.text.trim() !== "" || (message.mentions?.length ?? 0) > 0)
      .map(savedMessage);
    if (draft === "" && queue.length === 0) continue;
    composers[id] = {
      draft,
      mentionPaths: draft === "" ? [] : (ui.mentionPaths[id] ?? []),
      imagesNotKept:
        draft === "" ? 0 : (ui.attachments[id]?.length ?? 0) + (ui.draftImagesNotKept[id] ?? 0),
      queue,
    };
  }
  return composers;
}

/** The UI state a saved composer brings back: the draft as it was, every message held. */
function restoreComposers(ui: UiState, saved: WindowState["composers"]): UiState {
  let { drafts, mentionPaths, draftImagesNotKept, queues } = ui;
  for (const [id, composer] of Object.entries(saved)) {
    if (composer.draft !== "" && drafts[id] === undefined) {
      drafts = { ...drafts, [id]: composer.draft };
      if (composer.mentionPaths.length > 0) {
        mentionPaths = { ...mentionPaths, [id]: composer.mentionPaths };
      }
      if (composer.imagesNotKept > 0) {
        draftImagesNotKept = { ...draftImagesNotKept, [id]: composer.imagesNotKept };
      }
    }
    if (composer.queue.length > 0 && queues[id] === undefined) {
      const restored = composer.queue.map(
        (message, index): QueuedMessage => ({
          id: `restored-${id}-${index}`,
          text: message.text,
          state: "held",
          restored: true,
          ...(message.mentions.length > 0 ? { mentions: message.mentions } : {}),
          ...(message.imagesNotKept > 0 ? { imagesNotKept: message.imagesNotKept } : {}),
        }),
      );
      queues = { ...queues, [id]: restored };
    }
  }
  return { ...ui, drafts, mentionPaths, draftImagesNotKept, queues };
}

/**
 * Drops the unsent words kept for sessions that are gone (deleted, or archived elsewhere), once
 * the engine has listed the sessions there are. The same object when nothing goes.
 */
export function forgetComposersExcept(ui: UiState, known: ReadonlySet<string>): UiState {
  const keep = <T>(record: Record<string, T>): Record<string, T> => {
    const gone = Object.keys(record).filter((id) => !known.has(id));
    if (gone.length === 0) return record;
    const next = { ...record };
    for (const id of gone) delete next[id];
    return next;
  };
  const drafts = keep(ui.drafts);
  const mentionPaths = keep(ui.mentionPaths);
  const draftImagesNotKept = keep(ui.draftImagesNotKept);
  const queues = keep(ui.queues);
  if (
    drafts === ui.drafts &&
    mentionPaths === ui.mentionPaths &&
    draftImagesNotKept === ui.draftImagesNotKept &&
    queues === ui.queues
  ) {
    return ui;
  }
  return { ...ui, drafts, mentionPaths, draftImagesNotKept, queues };
}

/**
 * Layout, seen marks and unsent words from a loaded window state, over the current ones. Saved
 * queued messages come back held.
 */
export function applyWindowState(
  state: Pick<AppState, "layout" | "ui">,
  saved: WindowState,
): { layout: Layout; ui: UiState } {
  return {
    layout: {
      ...state.layout,
      sidebarOpen: saved.sidebarOpen,
      sidebarWidth: saved.sidebarWidth,
      dockOpen: saved.dockOpen,
      dockPane: saved.dockPane,
      dockWidth: saved.dockWidth,
      selectedSessionId: saved.selectedSessionId,
    },
    ui: restoreComposers(
      { ...state.ui, seenSeq: { ...saved.seenSeq, ...state.ui.seenSeq } },
      saved.composers,
    ),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Widths the window-state schema accepts: whole pixels within the limits. */
export function clampSidebarWidth(px: number): number {
  return clamp(px, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max);
}

export function clampDockWidth(px: number): number {
  return clamp(px, DOCK_WIDTH.min, DOCK_WIDTH.max);
}

function sameWindowState(a: WindowState, b: WindowState): boolean {
  return (
    a.sidebarOpen === b.sidebarOpen &&
    a.sidebarWidth === b.sidebarWidth &&
    a.dockOpen === b.dockOpen &&
    a.dockPane === b.dockPane &&
    a.dockWidth === b.dockWidth &&
    a.selectedSessionId === b.selectedSessionId &&
    a.seenSeq === b.seenSeq &&
    JSON.stringify(a.composers) === JSON.stringify(b.composers)
  );
}

export interface WindowStateSaver {
  /**
   * Saves `state` once no newer state arrived for `SAVE_DELAY_MS`, or `SAVE_MAX_WAIT_MS` after the
   * first unsaved change, whichever comes first.
   */
  schedule(state: WindowState): void;
  /** Saves a scheduled state now. */
  flush(): void;
  cancel(): void;
}

export function createWindowStateSaver(
  bridge: DawgBridge,
  onError: (error: unknown) => void,
  delayMs = SAVE_DELAY_MS,
  maxWaitMs = SAVE_MAX_WAIT_MS,
): WindowStateSaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: WindowState | null = null;
  let last: WindowState | null = null;
  /** When the oldest unsaved change was scheduled. */
  let pendingSince: number | null = null;

  function save(): void {
    timer = null;
    pendingSince = null;
    const state = pending;
    pending = null;
    if (!state || (last && sameWindowState(last, state))) return;
    last = state;
    bridge.windowState.save(state).catch(onError);
  }

  return {
    schedule(state) {
      pending = state;
      const now = Date.now();
      pendingSince ??= now;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(save, Math.max(0, Math.min(delayMs, pendingSince + maxWaitMs - now)));
    },
    flush() {
      if (timer === null) return;
      clearTimeout(timer);
      save();
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
      pendingSince = null;
    },
  };
}
