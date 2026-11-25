/**
 * Test helpers for the connected components of the app shell, sidebar, composer and Settings
 * (imported by tests only).
 *
 * The state layer is built separately, so connected tests do not depend on its selectors or
 * actions: they use a plain Zustand store holding `initialAppState(…)`, fake actions (vi.fn) that
 * apply the obvious layout and settings changes, and selectors replaced through `vi.mock` with
 * `mockedSelectors` below, which return the view models a test puts in `testViews`:
 *
 *   vi.mock("../state/selectors.ts", async (importOriginal) => ({
 *     ...(await importOriginal<object>()),
 *     ...(await import("../app/testing.tsx")).mockedSelectors,
 *   }));
 */
import type { SessionId } from "@dawg/protocol";
import type { ReactElement } from "react";
import { type Mock, vi } from "vitest";
import { createStore, type StoreApi } from "zustand";
import type { ModelOption, ResolvedTheme } from "../../shared/bridge.ts";
import { MOCK_MODELS } from "../../shared/mock-models.ts";
import { AppStoreProvider, initialAppState } from "../state/store.ts";
import type {
  AppActions,
  AppState,
  AppStore,
  ComposerView,
  ModelFooterView,
  SidebarGroup,
  TitleBarView,
  TranscriptView,
} from "../state/types.ts";
import { renderInTheme } from "../test/render.tsx";
import { type PlatformOs, PlatformProvider } from "./platform.tsx";

export const HOME = "/Users/me";

export const TEST_MODELS: ModelOption[] = MOCK_MODELS.map((model) => model.option);

export type FakeActions = { [K in keyof AppActions]: Mock<AppActions[K]> };

export interface TestStore {
  store: StoreApi<AppStore>;
  actions: FakeActions;
}

/** A store with fake actions. `patch` adjusts the initial state. */
export function createTestStore(patch?: (state: AppState) => Partial<AppState>): TestStore {
  let store: StoreApi<AppStore> | null = null;
  const get = (): AppStore => {
    if (!store) throw new Error("store not ready");
    return store.getState();
  };
  const set = (partial: Partial<AppStore>) => store?.setState(partial);
  const layout = (change: Partial<AppState["layout"]>) =>
    set({ layout: { ...get().layout, ...change } });
  const settings = (change: Partial<AppState["settings"]>) =>
    set({ settings: { ...get().settings, ...change } });
  const done = async () => {};

  const actions: FakeActions = {
    start: vi.fn(done),
    stop: vi.fn(),
    selectSession: vi.fn((id: SessionId) => layout({ selectedSessionId: id })),
    setView: vi.fn((view) => layout({ view })),
    setSettingsPage: vi.fn((settingsPage) => layout({ settingsPage })),
    setSidebarOpen: vi.fn((sidebarOpen) => layout({ sidebarOpen })),
    setSidebarWidth: vi.fn((sidebarWidth) => layout({ sidebarWidth })),
    openPane: vi.fn((dockPane) => layout({ dockOpen: true, dockPane })),
    closeDock: vi.fn(() => layout({ dockOpen: false })),
    setDockWidth: vi.fn((dockWidth) => layout({ dockWidth })),
    setSearch: vi.fn((search) => layout({ search })),
    dismissNotice: vi.fn((id) => set({ notices: get().notices.filter((n) => n.id !== id) })),
    setAppearance: vi.fn(async (appearance) => settings({ appearance })),
    setToolCallDisplay: vi.fn(async (toolCalls) => settings({ toolCalls })),
    setResolvedTheme: vi.fn((resolvedTheme: ResolvedTheme) => set({ resolvedTheme })),
    newSession: vi.fn(async () => null),
    renameSession: vi.fn(done),
    forkSession: vi.fn(async () => null),
    archiveSession: vi.fn(done),
    deleteSession: vi.fn(done),
    markUnread: vi.fn(),
    setDraft: vi.fn((sessionId, text) =>
      set({ ui: { ...get().ui, drafts: { ...get().ui.drafts, [sessionId]: text } } }),
    ),
    submit: vi.fn(done),
    interrupt: vi.fn(done),
    sendQueuedNow: vi.fn(done),
    removeQueued: vi.fn(),
    setMode: vi.fn(done),
    cycleMode: vi.fn(done),
    setModel: vi.fn(done),
    setEffort: vi.fn(done),
    compact: vi.fn(done),
    respondPermission: vi.fn(done),
    respondQuestion: vi.fn(done),
    respondPlan: vi.fn(done),
    setItemOpen: vi.fn(),
    setShownAgain: vi.fn(),
  };

  const base = initialAppState(HOME);
  const state: AppState = { ...base, models: TEST_MODELS, ...patch?.(base) };
  store = createStore<AppStore>()(() => ({ ...state, resolvedTheme: "dark", actions }));
  return { store, actions };
}

/** Renders inside the store and platform providers, in a theme. */
export function renderWithStore(
  ui: ReactElement,
  options: { theme: ResolvedTheme; store: StoreApi<AppStore>; os?: PlatformOs },
) {
  return renderInTheme(
    <PlatformProvider os={options.os ?? "darwin"}>
      <AppStoreProvider store={options.store}>{ui}</AppStoreProvider>
    </PlatformProvider>,
    options.theme,
  );
}

// ---------------------------------------------------------------------------------------------
// View models (the approved mockup's sample data)
// ---------------------------------------------------------------------------------------------

export function sampleSidebar(): SidebarGroup[] {
  const row = (
    sessionId: string,
    title: string,
    mark: SidebarGroup["rows"][number]["mark"],
    markLabel: string,
    subtitle: string | null,
    timeLabel: string,
    extra: Partial<SidebarGroup["rows"][number]> = {},
  ) => ({
    sessionId,
    title,
    mark,
    markLabel,
    subtitle,
    timeLabel,
    selected: false,
    worktree: false,
    ...extra,
  });
  return [
    {
      projectDir: `${HOME}/code/tally`,
      name: "tally",
      displayPath: "~/code/tally",
      rows: [
        row(
          "fix",
          "Fix the failing split test",
          "working",
          "Working",
          "Working: editing money.py",
          "now",
          {
            selected: true,
            worktree: true,
          },
        ),
        row(
          "csv",
          "Flaky CSV import test",
          "needs-you",
          "Needs you",
          "Needs you: run a command",
          "3m",
        ),
        row("pdf", "Receipt PDF layout", "unread", "Done, unread", "Done, not opened yet", "1h"),
      ],
    },
    {
      projectDir: `${HOME}/code/dawg-site`,
      name: "dawg-site",
      displayPath: "~/code/dawg-site",
      rows: [
        row("docs", "Docs search page", "queued", "Queued", "Queued: waits for the model", "1m"),
        row("links", "Fix broken links in docs", "idle", "Idle", null, "Yesterday"),
      ],
    },
    {
      projectDir: `${HOME}/code/notes-cli`,
      name: "notes-cli",
      displayPath: "~/code/notes-cli",
      rows: [
        row(
          "py",
          "Bump to Python 3.13",
          "error",
          "Error",
          "Error: the model stopped responding",
          "Mon",
        ),
      ],
    },
  ];
}

export const SAMPLE_FOOTER: ModelFooterView = {
  label: "Qwen3.8 27B · 8-bit",
  state: "ready",
  detail: "Ready · 1 running, 1 queued",
};

export function sampleTitleBar(overrides: Partial<TitleBarView> = {}): TitleBarView {
  return {
    sessionId: "fix",
    title: "Fix the failing split test",
    projectName: "tally",
    worktreeLabel: "worktree · split-cents",
    changes: { files: 3, additions: 11, deletions: 2 },
    tasks: { done: 1, total: 3 },
    ...overrides,
  };
}

export function sampleComposer(overrides: Partial<ComposerView> = {}): ComposerView {
  return {
    sessionId: "fix",
    status: "idle",
    working: false,
    answering: null,
    placeholder: "Reply to dawg. / for commands, @ to mention a file",
    mode: "acceptEdits",
    model: { id: "qwen3.8-27b-q8", label: "Qwen3.8 27B · 8-bit" },
    effort: { value: "xhigh", levels: ["low", "medium", "high", "xhigh"] },
    context: {
      used: 74_200,
      window: 204_800,
      fraction: 74_200 / 204_800,
      last: {
        promptTokens: 74_200,
        cachedTokens: 72_000,
        completionTokens: 320,
        promptTokensPerSecond: 1240,
        completionTokensPerSecond: 41,
      },
      compactAt: 133_120,
      breakdown: { systemPrompt: 4_112, instructions: 1_186, tools: 10_992, messages: 57_910 },
      compacting: false,
    },
    queue: [],
    commands: [
      {
        name: "compact",
        description: "Summarise the conversation to free context",
        argumentHint: "[focus]",
      },
      { name: "context", description: "Show what fills the context", argumentHint: null },
      { name: "help", description: "List the commands", argumentHint: null },
      { name: "clear", description: "Start over with an empty context", argumentHint: null },
    ],
    draft: "",
    canAttachImages: true,
    ...overrides,
  };
}

export function sampleTranscript(sessionId: SessionId): TranscriptView {
  return {
    sessionId,
    items: [],
    loaded: true,
    working: false,
    activeTurnId: null,
    promptProgress: null,
    toolCallDisplay: "smart",
    openItems: {},
    shownAgain: {},
    queuedTurnIds: {},
    cwd: `${HOME}/code/tally`,
  };
}

// ---------------------------------------------------------------------------------------------
// Mocked selectors
// ---------------------------------------------------------------------------------------------

export interface TestViews {
  sidebar: SidebarGroup[];
  footer: ModelFooterView;
  titleBar: TitleBarView;
  /** Per session; the draft comes from `state.ui.drafts`, as the real selector does. */
  composer: Record<SessionId, ComposerView>;
  transcript: Record<SessionId, TranscriptView>;
}

export const testViews: TestViews = {
  sidebar: [],
  footer: SAMPLE_FOOTER,
  titleBar: sampleTitleBar(),
  composer: {},
  transcript: {},
};

export function resetTestViews(views: Partial<TestViews> = {}): void {
  Object.assign(testViews, {
    sidebar: [],
    footer: SAMPLE_FOOTER,
    titleBar: sampleTitleBar(),
    composer: {},
    transcript: {},
    ...views,
  });
}

// Selectors must return the same object for unchanged inputs.
const composerCache = new WeakMap<ComposerView, { draft: string; view: ComposerView }>();

export const mockedSelectors = {
  selectSidebar: (_state: AppStore, _now: number) => testViews.sidebar,
  selectModelFooter: (_state: AppStore) => testViews.footer,
  selectTitleBar: (_state: AppStore) => testViews.titleBar,
  selectTranscript: (_state: AppStore, id: SessionId) => testViews.transcript[id] ?? null,
  selectComposer: (state: AppStore, id: SessionId): ComposerView | null => {
    const base = testViews.composer[id];
    if (!base) return null;
    const draft = state.ui.drafts[id] ?? "";
    const cached = composerCache.get(base);
    if (cached && cached.draft === draft) return cached.view;
    const view = { ...base, draft };
    composerCache.set(base, { draft, view });
    return view;
  },
};
