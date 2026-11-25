/**
 * Selectors: state → view models. Contract: keep these names and signatures. Every selector is
 * memoised so that unchanged inputs give the same object back, and the view models are rebuilt
 * from the previous ones where nothing visible changed (`stable`), so a component subscribed
 * to the sidebar does not re-render for every streamed token of another session.
 */
import type { SessionId } from "@dawg/protocol";
import { basename, formatRelativeTime, shortenPath } from "../lib/format.ts";
import { createKeyedMemo, shallowEqual, stable } from "./memo.ts";
import { isQueuedForModel, MARK_LABELS, sessionMark } from "./session-marks.ts";
import { sidebarOrder } from "./sidebar-order.ts";
import { INTERRUPTED_BY_YOU_NOTE, INTERRUPTED_NOTE } from "./transcript-events.ts";
import type {
  AppChromeView,
  AppStore,
  ComposerView,
  ContextMeterView,
  ModelFooterView,
  NoteItem,
  PendingRef,
  QueuedMessage,
  SessionView,
  SidebarGroup,
  SidebarRow,
  TitleBarView,
  TranscriptItem,
  TranscriptView,
} from "./types.ts";

const EMPTY_ITEMS: readonly TranscriptItem[] = Object.freeze([]);
const EMPTY_PENDING: readonly PendingRef[] = Object.freeze([]);
const EMPTY_QUEUE: readonly QueuedMessage[] = Object.freeze([]);
const EMPTY_FLAGS: Readonly<Record<string, boolean>> = Object.freeze({});

export const PLACEHOLDERS = {
  idle: "Reply to dawg. / for commands, @ to mention a file",
  permission: "Waiting on you. A message here denies the command and tells dawg why.",
  question: "Waiting on you. A message here answers the question.",
  plan: "Waiting on you. A message here keeps planning, with your feedback.",
} as const;

function sameElements<T>(previous: readonly T[] | undefined, next: T[]): readonly T[] {
  if (!previous || previous.length !== next.length) return next;
  return next.every((value, index) => value === previous[index]) ? previous : next;
}

// --- Sidebar ---------------------------------------------------------------------------------

const sidebarMemo = createKeyedMemo<SidebarGroup[]>(4);
const rowCache = new Map<SessionId, SidebarRow>();
const groupCache = new Map<string, SidebarGroup>();

/** Sessions grouped by project, newest activity first, filtered by `layout.search`. `now` drives relative times. */
export function selectSidebar(state: AppStore, now: number): SidebarGroup[] {
  const { sessions, pending, transcripts, ui, layout } = state;
  return sidebarMemo.get(
    "sidebar",
    [
      sessions,
      pending,
      transcripts,
      ui.seenSeq,
      ui.markedUnread,
      ui.stoppedByUser,
      layout.selectedSessionId,
      layout.search,
      state.projects,
      state.homeDir,
      now,
    ],
    (previous) => {
      // One model serves every project, so the line is counted across all of them.
      const queuedCount = Object.values(sessions).filter(isQueuedForModel).length;
      const sidebarRow = (session: SessionView): SidebarRow => {
        const selected = session.id === layout.selectedSessionId;
        const { mark, subtitle } = sessionMark({
          session,
          pending: pending[session.id] ?? EMPTY_PENDING,
          items: transcripts[session.id] ?? EMPTY_ITEMS,
          seenSeq: ui.seenSeq[session.id],
          markedUnread: ui.markedUnread[session.id] ?? false,
          stoppedByUser: ui.stoppedByUser[session.id] ?? false,
          selected,
          queuedCount,
        });
        const row = stable<SidebarRow>(rowCache.get(session.id), {
          sessionId: session.id,
          title: session.summary.title ?? "New session",
          mark,
          markLabel: MARK_LABELS[mark],
          subtitle,
          timeLabel:
            mark === "working" ? "now" : formatRelativeTime(session.summary.lastActivityAt, now),
          selected,
          worktree: session.summary.cwd !== session.summary.projectDir,
        });
        rowCache.set(session.id, row);
        return row;
      };
      const groups: SidebarGroup[] = [];
      for (const { projectDir: dir, sessions: listed } of sidebarOrder(sessions, layout.search)) {
        const cached = groupCache.get(dir);
        const group = stable<SidebarGroup>(cached, {
          projectDir: dir,
          name: state.projects[dir]?.name ?? basename(dir),
          displayPath: shortenPath(dir, state.homeDir),
          rows: sameElements(cached?.rows, listed.map(sidebarRow)) as SidebarRow[],
        });
        groupCache.set(dir, group);
        groups.push(group);
      }
      return sameElements(previous, groups) as SidebarGroup[];
    },
  );
}

// --- Model footer ------------------------------------------------------------------------------

const footerMemo = createKeyedMemo<ModelFooterView>(4);

const NOT_READY_DETAIL: Record<ModelFooterView["state"], string> = {
  ready: "Ready",
  loading: "Loading",
  stopped: "Stopped",
  error: "Error",
};

export function selectModelFooter(state: AppStore): ModelFooterView {
  const { models, modelStatus, sessions, pending } = state;
  return footerMemo.get("footer", [models, modelStatus, sessions, pending], (previous) => {
    const modelId = modelStatus?.modelId ?? null;
    const label =
      (modelId !== null ? models.find((model) => model.id === modelId)?.shortLabel : undefined) ??
      modelStatus?.label ??
      modelId ??
      "No model";
    const status = modelStatus?.state ?? "stopped";
    let detail: string;
    if (status === "ready") {
      let running = 0;
      let queued = 0;
      for (const session of Object.values(sessions)) {
        if ((pending[session.id]?.length ?? 0) > 0 || session.status === "waiting") continue;
        if (isQueuedForModel(session)) queued++;
        else if (session.status === "working" || session.activeTurnId !== null) running++;
      }
      const counts = [
        ...(running > 0 ? [`${running} running`] : []),
        ...(queued > 0 ? [`${queued} queued`] : []),
      ];
      detail = counts.length > 0 ? `Ready · ${counts.join(", ")}` : "Ready";
    } else {
      detail = modelStatus?.message ?? NOT_READY_DETAIL[status];
    }
    return stable(previous, { label, state: status, detail });
  });
}

// --- Title bar ---------------------------------------------------------------------------------

const EMPTY_TITLE: TitleBarView = {
  sessionId: null,
  title: "dawg-code",
  projectName: null,
  worktreeLabel: null,
  changes: null,
  tasks: null,
};

const titleMemo = createKeyedMemo<TitleBarView>(4);

function changeTotals(items: readonly TranscriptItem[]): TitleBarView["changes"] {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const item of items) {
    if (item.kind !== "tool" || item.state !== "success" || item.display?.kind !== "diff") continue;
    files.add(item.display.filePath);
    additions += item.display.additions;
    deletions += item.display.deletions;
  }
  return files.size === 0 ? null : { files: files.size, additions, deletions };
}

/** For the selected session. */
export function selectTitleBar(state: AppStore): TitleBarView {
  const id = state.layout.selectedSessionId;
  const session = id ? state.sessions[id] : undefined;
  if (!id || !session) return EMPTY_TITLE;
  const items = state.transcripts[id] ?? EMPTY_ITEMS;
  return titleMemo.get(
    "title",
    [id, session.summary, session.tasks, items, state.projects],
    (previous) => {
      const { summary } = session;
      const changes = changeTotals(items);
      const done = session.tasks.filter((task) => task.status === "completed").length;
      const tasks = session.tasks.length > 0 ? { done, total: session.tasks.length } : null;
      return stable(previous, {
        sessionId: id,
        title: summary.title ?? "New session",
        projectName: state.projects[summary.projectDir]?.name ?? basename(summary.projectDir),
        worktreeLabel:
          summary.cwd !== summary.projectDir ? `worktree · ${basename(summary.cwd)}` : null,
        changes:
          previous?.changes && shallowEqual(previous.changes, changes) ? previous.changes : changes,
        tasks: previous?.tasks && shallowEqual(previous.tasks, tasks) ? previous.tasks : tasks,
      });
    },
  );
}

// --- Transcript --------------------------------------------------------------------------------

const transcriptMemo = createKeyedMemo<TranscriptView>();
const itemsMemo = createKeyedMemo<readonly TranscriptItem[]>();
/** Rewritten notes keep their identity, so a memoised item component does not re-render. */
const byYouNotes = new WeakMap<NoteItem, NoteItem>();

/** Says "Interrupted by you" on the turns this client interrupted. */
function withInterruptions(
  sessionId: SessionId,
  items: readonly TranscriptItem[],
  interrupted: Readonly<Record<string, true>>,
): readonly TranscriptItem[] {
  return itemsMemo.get(sessionId, [items, interrupted], () => {
    let changed = false;
    const next = items.map((item) => {
      if (
        item.kind !== "note" ||
        item.text !== INTERRUPTED_NOTE ||
        item.turnId === null ||
        !interrupted[item.turnId]
      ) {
        return item;
      }
      changed = true;
      let rewritten = byYouNotes.get(item);
      if (!rewritten) {
        rewritten = { ...item, text: INTERRUPTED_BY_YOU_NOTE };
        byYouNotes.set(item, rewritten);
      }
      return rewritten;
    });
    return changed ? next : items;
  });
}

export function selectTranscript(state: AppStore, sessionId: SessionId): TranscriptView | null {
  const session = state.sessions[sessionId];
  if (!session) return null;
  const rawItems = state.transcripts[sessionId] ?? EMPTY_ITEMS;
  const interrupted = state.ui.interruptedTurns;
  const openItems = state.ui.openItems[sessionId] ?? EMPTY_FLAGS;
  const shownAgain = state.ui.shownAgain[sessionId] ?? EMPTY_FLAGS;
  return transcriptMemo.get(
    sessionId,
    [
      rawItems,
      interrupted,
      session.loaded,
      session.activeTurnId,
      session.promptProgress,
      state.settings.toolCalls,
      openItems,
      shownAgain,
      state.ui.fromQueueTurns,
      session.summary.cwd,
    ],
    () => ({
      sessionId,
      items:
        Object.keys(interrupted).length > 0
          ? withInterruptions(sessionId, rawItems, interrupted)
          : rawItems,
      loaded: session.loaded,
      working: session.activeTurnId !== null,
      activeTurnId: session.activeTurnId,
      promptProgress: session.promptProgress,
      toolCallDisplay: state.settings.toolCalls,
      openItems,
      shownAgain,
      queuedTurnIds: state.ui.fromQueueTurns,
      cwd: session.summary.cwd,
    }),
  );
}

// --- Composer ----------------------------------------------------------------------------------

const composerMemo = createKeyedMemo<ComposerView>();

function contextMeter(
  session: AppStore["sessions"][string],
  previous: ContextMeterView | null | undefined,
): ContextMeterView | null {
  const { usage, modelInfo } = session;
  if (!usage && !modelInfo) return null;
  const window =
    usage && usage.contextWindow > 0 ? usage.contextWindow : (modelInfo?.contextWindow ?? 0);
  const used = usage?.contextUsed ?? 0;
  const last = usage
    ? stable(previous?.last ?? undefined, {
        promptTokens: usage.last.promptTokens,
        cachedTokens: usage.last.cachedTokens,
        completionTokens: usage.last.completionTokens,
        promptTokensPerSecond: usage.last.promptTokensPerSecond,
        completionTokensPerSecond: usage.last.completionTokensPerSecond,
      })
    : null;
  const breakdown = usage?.breakdown ?? null;
  return stable(previous ?? undefined, {
    used,
    window,
    fraction: window > 0 ? Math.min(1, used / window) : 0,
    last,
    compactAt: usage?.compactAt ?? null,
    breakdown: breakdown && stable(previous?.breakdown ?? undefined, { ...breakdown }),
    compacting: session.compactionId !== null,
  });
}

export function selectComposer(state: AppStore, sessionId: SessionId): ComposerView | null {
  const session = state.sessions[sessionId];
  if (!session) return null;
  const pending = state.pending[sessionId] ?? EMPTY_PENDING;
  const queue = state.ui.queues[sessionId] ?? EMPTY_QUEUE;
  const draft = state.ui.drafts[sessionId] ?? "";
  return composerMemo.get(sessionId, [session, pending, state.models, queue, draft], (previous) => {
    const answering = pending[0] ?? null;
    const { summary } = session;
    const modelLabel =
      (summary.model !== null
        ? state.models.find((model) => model.id === summary.model)?.shortLabel
        : undefined) ??
      summary.model ??
      "No model";
    const effortLevels = session.modelInfo?.effortLevels ?? [];
    const next: ComposerView = {
      sessionId,
      status: session.status,
      working: (session.activeTurnId !== null || session.status === "working") && !answering,
      answering,
      placeholder: answering ? PLACEHOLDERS[answering.kind] : PLACEHOLDERS.idle,
      mode: summary.mode,
      model: stable(previous?.model, { id: summary.model, label: modelLabel }),
      effort: stable(previous?.effort, {
        value: summary.effort,
        levels: sameElements(previous?.effort.levels, effortLevels) as string[],
      }),
      context: contextMeter(session, previous?.context),
      queue,
      commands: session.commands,
      draft,
      canAttachImages: session.modelInfo?.vision ?? false,
    };
    return stable(previous, next);
  });
}

// --- Chrome ------------------------------------------------------------------------------------

let chromeCache: { key: unknown[]; value: AppChromeView } | null = null;

export function selectChrome(state: AppStore): AppChromeView {
  const key = [state.resolvedTheme, state.settings, state.layout, state.connection, state.notices];
  if (chromeCache && key.every((part, index) => part === chromeCache?.key[index])) {
    return chromeCache.value;
  }
  const value: AppChromeView = stable(chromeCache?.value, {
    theme: state.resolvedTheme,
    appearance: state.settings.appearance,
    view: state.layout.view,
    settingsPage: state.layout.settingsPage,
    sidebarOpen: state.layout.sidebarOpen,
    sidebarWidth: state.layout.sidebarWidth,
    dockOpen: state.layout.dockOpen,
    dockPane: state.layout.dockPane,
    dockWidth: state.layout.dockWidth,
    connection: state.connection,
    notices: state.notices,
  });
  chromeCache = { key, value };
  return value;
}

export function selectSelectedSessionId(state: AppStore): SessionId | null {
  return state.layout.selectedSessionId;
}
