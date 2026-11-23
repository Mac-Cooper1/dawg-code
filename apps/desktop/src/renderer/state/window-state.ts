/**
 * What a window remembers between launches (layout, selection, seen marks), and the debounced
 * save through the bridge. Dragging a splitter fires dozens of changes a second; one save
 * follows the last of them.
 */
import {
  type DawgBridge,
  DOCK_WIDTH,
  SIDEBAR_WIDTH,
  type WindowState,
} from "../../shared/bridge.ts";
import type { AppState, Layout, UiState } from "./types.ts";

export const SAVE_DELAY_MS = 500;

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
  };
}

/** Layout and seen marks from a loaded window state, over the current ones. */
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
    ui: { ...state.ui, seenSeq: { ...saved.seenSeq, ...state.ui.seenSeq } },
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
    a.seenSeq === b.seenSeq
  );
}

export interface WindowStateSaver {
  /** Saves `state` once no newer state arrived for `SAVE_DELAY_MS`. */
  schedule(state: WindowState): void;
  /** Saves a scheduled state now. */
  flush(): void;
  cancel(): void;
}

export function createWindowStateSaver(
  bridge: DawgBridge,
  onError: (error: unknown) => void,
  delayMs = SAVE_DELAY_MS,
): WindowStateSaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: WindowState | null = null;
  let last: WindowState | null = null;

  function save(): void {
    timer = null;
    const state = pending;
    pending = null;
    if (!state || (last && sameWindowState(last, state))) return;
    last = state;
    bridge.windowState.save(state).catch(onError);
  }

  return {
    schedule(state) {
      pending = state;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(save, delayMs);
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
    },
  };
}
