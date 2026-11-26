/**
 * Whether the command palette is open, and what it shows. UI state only, kept beside the store
 * (one controller per store) rather than in it, so the window's key handler and the palette share
 * it without a field in the app state.
 */
import type { SessionId } from "@dawg/protocol";
import { useSyncExternalStore } from "react";
import type { AppStoreApi } from "../../state/store.ts";
import type { PaletteUi } from "../commands/types.ts";

export type PaletteView =
  | { kind: "closed" }
  | { kind: "list" }
  /** A field for the session's new title. */
  | { kind: "rename"; sessionId: SessionId };

export interface PaletteSnapshot {
  view: PaletteView;
  /** The session the delete confirmation asks about, while it shows. */
  deleting: SessionId | null;
}

const CLOSED: PaletteSnapshot = { view: { kind: "closed" }, deleting: null };

export class PaletteController implements PaletteUi {
  private snapshot: PaletteSnapshot = CLOSED;
  private readonly listeners = new Set<() => void>();
  /** Runs once the palette has closed and given focus back (`settle`). */
  private afterClose: (() => void)[] = [];
  /** What had focus before the palette opened, to give it back. */
  private focusBefore: HTMLElement | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): PaletteSnapshot => this.snapshot;

  get isOpen(): boolean {
    return this.snapshot.view.kind !== "closed";
  }

  private set(patch: Partial<PaletteSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    if (next.view === this.snapshot.view && next.deleting === this.snapshot.deleting) return;
    if (this.snapshot.view.kind === "closed" && next.view.kind !== "closed") {
      const active = typeof document === "undefined" ? null : document.activeElement;
      this.focusBefore = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }

  open(): void {
    if (this.snapshot.view.kind !== "list") this.set({ view: { kind: "list" } });
  }

  close(): void {
    if (this.isOpen) this.set({ view: { kind: "closed" } });
    else this.flush();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  rename(sessionId: SessionId): void {
    this.set({ view: { kind: "rename", sessionId } });
  }

  confirmDelete(sessionId: SessionId): void {
    // The confirmation is its own dialog: it opens once the palette has gone.
    this.whenClosed(() => this.set({ deleting: sessionId }));
  }

  endDelete(): void {
    this.set({ deleting: null });
  }

  /**
   * Runs `task` once the palette is closed and focus is back where it was: at once when the
   * palette is not open. For actions that move focus or open a dialog of their own.
   */
  whenClosed(task: () => void): void {
    if (!this.isOpen) {
      task();
      return;
    }
    this.afterClose.push(task);
    this.close();
  }

  /** The element to give focus back to, if it is still in the window. */
  takeFocusBefore(): HTMLElement | null {
    const element = this.focusBefore;
    this.focusBefore = null;
    return element?.isConnected ? element : null;
  }

  /** Called by the palette once it has closed: runs what waited for it. */
  flush(): void {
    const tasks = this.afterClose;
    this.afterClose = [];
    for (const task of tasks) task();
  }
}

const controllers = new WeakMap<AppStoreApi, PaletteController>();

/** The palette of the window that owns `store`. */
export function paletteFor(store: AppStoreApi): PaletteController {
  let controller = controllers.get(store);
  if (!controller) {
    controller = new PaletteController();
    controllers.set(store, controller);
  }
  return controller;
}

export function usePaletteSnapshot(controller: PaletteController): PaletteSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot);
}
