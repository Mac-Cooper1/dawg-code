/**
 * The renderer's store. Contract: keep these exports and their signatures; the initial state
 * below is part of the contract and may be extended.
 *
 * Components never import a module-level store: they read the store from React context
 * (`AppStoreProvider`), so tests can render with an isolated store.
 *
 * The store is fed by one reducer (reducer.ts) through the engine connection (connection.ts),
 * one batch per animation frame; actions live in actions.ts.
 */
import { createContext, createElement, type ReactNode, useContext } from "react";
import { createStore, type StoreApi, useStore } from "zustand";
import {
  type DawgBridge,
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_STATE,
  type WindowState,
} from "../../shared/bridge.ts";
import { createRuntime } from "./actions.ts";
import type { FrameScheduler } from "./batcher.ts";
import type { AppActions, AppState, AppStore } from "./types.ts";

export interface AppStoreDeps {
  bridge: DawgBridge;
  /** Clock for relative times and debouncing. Default `Date.now`. */
  now?: () => number;
  /** How event batches wait for the next frame. Default: requestAnimationFrame (tests: a timer). */
  scheduleFrame?: FrameScheduler;
}

export type AppStoreApi = StoreApi<AppStore>;

/** The state before `start()` has loaded anything. */
export function initialAppState(
  homeDir: string,
  windowState: WindowState = DEFAULT_WINDOW_STATE,
): AppState {
  return {
    connection: { phase: "connecting" },
    homeDir,
    projects: {},
    sessions: {},
    transcripts: {},
    pending: {},
    layout: {
      view: "sessions",
      settingsPage: "general",
      sidebarOpen: windowState.sidebarOpen,
      sidebarWidth: windowState.sidebarWidth,
      dockOpen: windowState.dockOpen,
      dockPane: windowState.dockPane,
      dockWidth: windowState.dockWidth,
      selectedSessionId: windowState.selectedSessionId,
      search: "",
    },
    ui: {
      drafts: {},
      queues: {},
      openItems: {},
      shownAgain: {},
      seenSeq: { ...windowState.seenSeq },
      markedUnread: {},
      fromQueueTurns: {},
      stoppedByUser: {},
      interruptedTurns: {},
    },
    settings: DEFAULT_SETTINGS,
    models: [],
    modelStatus: null,
    notices: [],
  };
}

/** Until the runtime is attached (synchronously, below), actions do nothing. */
const INERT_ACTIONS = new Proxy({} as AppActions, {
  get: () => () => undefined,
});

/** Creates an isolated store. Call `actions.start()` to load settings and connect. */
export function createAppStore(deps: AppStoreDeps): AppStoreApi {
  const store = createStore<AppStore>()(() => ({
    ...initialAppState(deps.bridge.platform.homeDir),
    resolvedTheme: "dark",
    actions: INERT_ACTIONS,
  }));
  const runtime = createRuntime(store, {
    bridge: deps.bridge,
    now: deps.now ?? Date.now,
    ...(deps.scheduleFrame ? { scheduleFrame: deps.scheduleFrame } : {}),
  });
  store.setState({ actions: runtime.actions });
  return store;
}

export const AppStoreContext = createContext<AppStoreApi | null>(null);

export function AppStoreProvider(props: { store: AppStoreApi; children?: ReactNode }) {
  return createElement(AppStoreContext.Provider, { value: props.store }, props.children);
}

export function useAppStoreApi(): AppStoreApi {
  const store = useContext(AppStoreContext);
  if (!store) throw new Error("useAppStore needs an <AppStoreProvider> above it");
  return store;
}

/** Subscribes to a slice. Selectors must return stable references for unchanged state. */
export function useAppStore<T>(selector: (state: AppStore) => T): T {
  return useStore(useAppStoreApi(), selector);
}

export function useActions(): AppActions {
  return useAppStore((state) => state.actions);
}
