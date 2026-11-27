/**
 * The transcript of a session: every item in order, in a centred column that follows new output
 * until the person scrolls up. Renders only what it is given (`TranscriptProps`); it never reads
 * the store.
 *
 * Long sessions stay quick (README, "Performance") without windowing, so everything stays in the
 * page: selection across items, VoiceOver's reading order and the cards' shortcuts work as in a
 * short session.
 * - Items are drawn in groups of `GROUP_SIZE`. A group is memoised, so a streamed delta
 *   re-renders the transcript, one group and the item that changed, never every item; and it is
 *   one box the browser skips laying out and painting while it is off screen
 *   (`content-visibility: auto`), so the page lays out and paints about a screenful.
 * - A session that opens draws its newest items first, then the older ones in small steps while
 *   the window is idle.
 */
import {
  Fragment,
  memo,
  type ReactNode,
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PermissionCard } from "../cards/PermissionCard.tsx";
import { PlanCard } from "../cards/PlanCard.tsx";
import { QuestionCard } from "../cards/QuestionCard.tsx";
import { hookLine, hookTone, skippedLine } from "../lib/hooks.ts";
import { useReducedMotion } from "../markdown/index.ts";
import type {
  PermissionItem,
  ToolCallDisplay,
  TranscriptItem,
  TranscriptView,
} from "../state/types.ts";
import { Button, Spinner } from "../ui/index.ts";
import { AgentCard } from "./AgentCard.tsx";
import { AssistantText } from "./AssistantText.tsx";
import { isAgentCall } from "./agentInfo.ts";
import { CommandOutput } from "./CommandOutput.tsx";
import { CompactionView } from "./CompactionView.tsx";
import type { TranscriptProps } from "./contract.ts";
import { Divider } from "./Divider.tsx";
import { ErrorCard } from "./ErrorCard.tsx";
import type { TranscriptEnv } from "./env.ts";
import { ForkMarker, type ForkMarkerView, forkBoundary, turnNumber } from "./ForkMarker.tsx";
import { HookSkippedView, HookView } from "./HookView.tsx";
import { NoteView } from "./NoteView.tsx";
import { PromptProgress } from "./PromptProgress.tsx";
import { Reasoning } from "./Reasoning.tsx";
import { TasksCard } from "./TasksCard.tsx";
import { ToolCard } from "./ToolCard.tsx";
import styles from "./Transcript.module.css";
import { TurnSummaryView, turnSummaryText } from "./TurnSummaryView.tsx";
import { defaultToolOpen } from "./toolInfo.ts";
import { UserMessage } from "./UserMessage.tsx";
import { useFollowOutput } from "./useFollowOutput.ts";

/**
 * Whether a tool item is drawn. While its permission card waits, and after the person denied it,
 * the card (or its one-line record) stands for the call.
 */
export function isToolHidden(
  permissionRequestId: string | null,
  permissions: ReadonlyMap<string, PermissionItem>,
): boolean {
  if (permissionRequestId === null) return false;
  const permission = permissions.get(permissionRequestId);
  if (!permission) return false;
  if (permission.state === "pending") return true;
  return permission.state === "answered" && permission.response?.behavior === "deny";
}

/** A short sentence for VoiceOver when an item appears live, or null to stay quiet. */
export function announcementFor(item: TranscriptItem): string | null {
  switch (item.kind) {
    case "turn-summary":
      if (item.stopReason === "completed") return `dawg finished. ${turnSummaryText(item)}`;
      if (item.stopReason === "turn_limit") return "dawg stopped at the turn limit.";
      if (item.stopReason === "interrupted") return "The turn was stopped.";
      return null;
    case "permission":
      return item.state === "pending" ? `dawg needs permission: ${item.request.title}` : null;
    case "question":
      return item.state === "pending"
        ? `dawg is asking: ${item.questions.map((q) => q.question).join(" ")}`
        : null;
    case "plan":
      return item.state === "pending" ? "dawg has a plan ready for review." : null;
    case "error":
      return `Error: ${item.error.message}`;
    case "hook":
      // A plain run is quiet; a block or a failure is news.
      return hookTone(item) === "quiet" ? null : hookLine(item);
    case "hook-skipped":
      return skippedLine(item.sources);
    default:
      return null;
  }
}

/** Polite announcements of finished turns, new decisions and errors; never streamed text. */
function useAnnouncements(view: TranscriptView): string {
  const [text, setText] = useState("");
  const seen = useRef<Set<string> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: starts over for another session
  useLayoutEffect(() => {
    seen.current = null;
    setText("");
  }, [view.sessionId]);
  useEffect(() => {
    if (!view.loaded) return;
    if (seen.current === null) {
      // What was there when the session loaded is history, not news.
      seen.current = new Set(view.items.map((item) => item.id));
      return;
    }
    const fresh: string[] = [];
    for (const item of view.items) {
      if (seen.current.has(item.id)) continue;
      seen.current.add(item.id);
      const sentence = announcementFor(item);
      if (sentence) fresh.push(sentence);
    }
    if (fresh.length > 0) setText(fresh.join(" "));
  }, [view.items, view.loaded]);
  return text;
}

/** Items drawn together: a delta re-renders the group holding its item, not every row. */
const GROUP_SIZE = 25;
/** Items drawn at once when a session opens, newest first: more than a tall window holds. */
export const FIRST_ROWS = 30;
/** Older items added per idle step until the whole session is drawn. */
export const BACKFILL_ROWS = 50;

/** What rows need besides their item; one object while none of it changes. */
interface RowContext {
  openItems: TranscriptView["openItems"];
  shownAgain: TranscriptView["shownAgain"];
  toolCallDisplay: ToolCallDisplay;
  activeTurnId: string | null;
  queuedTurnIds: TranscriptView["queuedTurnIds"];
  permissions: ReadonlyMap<string, PermissionItem>;
  autoFocusPendingCard: boolean;
  /** A forked session's marker, and the item it goes before (null: at the end). */
  fork: { view: ForkMarkerView; beforeItemId: string | null; onOpen: (() => void) | null } | null;
}

function renderItem(item: TranscriptItem, context: RowContext, env: TranscriptEnv): ReactNode {
  const opened = context.openItems[item.id];
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} env={env} />;
    case "assistant":
      return <AssistantText item={item} env={env} />;
    case "reasoning":
      return <Reasoning item={item} open={opened ?? false} env={env} />;
    case "tool":
      if (isAgentCall(item)) {
        return (
          <AgentCard
            item={item}
            open={opened ?? defaultToolOpen(item, context.toolCallDisplay)}
            env={env}
          />
        );
      }
      return (
        <ToolCard
          item={item}
          open={opened ?? defaultToolOpen(item, context.toolCallDisplay)}
          env={env}
        />
      );
    case "tasks":
      return (
        <TasksCard
          item={item}
          running={context.activeTurnId !== null && item.turnId === context.activeTurnId}
          open={opened ?? false}
          env={env}
        />
      );
    case "permission":
      return (
        <PermissionCard
          item={item}
          shownAgain={context.shownAgain[item.requestId] ?? false}
          autoFocus={context.autoFocusPendingCard}
          env={env}
        />
      );
    case "question":
      return (
        <QuestionCard
          item={item}
          shownAgain={context.shownAgain[item.requestId] ?? false}
          autoFocus={context.autoFocusPendingCard}
          env={env}
        />
      );
    case "plan":
      return (
        <PlanCard
          item={item}
          shownAgain={context.shownAgain[item.requestId] ?? false}
          autoFocus={context.autoFocusPendingCard}
          env={env}
        />
      );
    case "note":
      return <NoteView item={item} />;
    case "compaction":
      return <CompactionView item={item} open={opened ?? false} env={env} />;
    case "turn-summary":
      return <TurnSummaryView item={item} />;
    case "error":
      return <ErrorCard item={item} open={opened ?? false} env={env} />;
    case "command-output":
      return <CommandOutput item={item} env={env} />;
    case "hook":
      return <HookView item={item} open={opened ?? false} env={env} />;
    case "hook-skipped":
      return <HookSkippedView item={item} env={env} />;
  }
}

/**
 * Heights to assume for a group's items until it has been on screen once (then the browser
 * keeps its real size): rough sizes per kind (a closed tool call is one 38 px line, an answer
 * runs to several paragraphs). They only steer the scroll bar before everything has been seen.
 */
const ESTIMATED_HEIGHT: Partial<Record<TranscriptItem["kind"], number>> = {
  user: 48,
  assistant: 220,
  reasoning: 24,
  tool: 38,
  note: 24,
  compaction: 24,
  "turn-summary": 24,
  hook: 24,
  "hook-skipped": 28,
};
const DEFAULT_HEIGHT = 120;
/** The column's gap between items, as in Transcript.module.css. */
const ROW_GAP = 12;

function estimatedHeight(items: readonly TranscriptItem[]): number {
  let height = 0;
  for (const item of items) height += (ESTIMATED_HEIGHT[item.kind] ?? DEFAULT_HEIGHT) + ROW_GAP;
  return Math.max(0, height - ROW_GAP);
}

function sameItems(a: readonly TranscriptItem[], b: readonly TranscriptItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

interface RowGroupProps {
  items: readonly TranscriptItem[];
  context: RowContext;
  env: TranscriptEnv;
}

/**
 * A run of items: one memoised component, so a delta re-renders the group holding its item and
 * no other, and one box the browser skips laying out and painting while it is off screen.
 */
const RowGroup = memo(
  function RowGroup({ items, context, env }: RowGroupProps) {
    const rows: ReactNode[] = [];
    for (const item of items) {
      if (item.kind === "tool" && isToolHidden(item.permissionRequestId, context.permissions)) {
        continue;
      }
      if (context.fork !== null && context.fork.beforeItemId === item.id) {
        rows.push(
          <ForkMarker
            key={`${item.id}:fork`}
            view={context.fork.view}
            onOpen={context.fork.onOpen}
          />,
        );
      }
      if (item.kind === "user" && item.turnId !== null && context.queuedTurnIds[item.turnId]) {
        rows.push(<Divider key={`${item.id}:queued`} text="Queued message sent" />);
      }
      rows.push(<Fragment key={item.id}>{renderItem(item, context, env)}</Fragment>);
    }
    return (
      <div
        className={styles.group}
        style={{ containIntrinsicBlockSize: `auto ${estimatedHeight(items)}px` }}
      >
        {rows}
      </div>
    );
  },
  (a, b) => a.context === b.context && a.env === b.env && sameItems(a.items, b.items),
);

/**
 * The item a fork's marker goes before: the first message of a turn the fork made itself, or the
 * first item for a fork from no particular turn. Null: after everything (no such turn yet).
 */
function forkPlace(items: readonly TranscriptItem[], fork: ForkMarkerView | null): string | null {
  if (fork === null) return null;
  const boundary = forkBoundary(fork.point);
  if (boundary === null) return items[0]?.id ?? null;
  for (const item of items) {
    if (item.kind !== "user") continue;
    const n = turnNumber(item.turnId);
    if (n !== null && n >= boundary) return item.id;
  }
  return null;
}

/** Runs `callback` once the window has a moment, or soon anyway. Returns a cancel function. */
function whenIdle(callback: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(callback, { timeout: 120 });
    return () => cancelIdleCallback(handle);
  }
  const timer = setTimeout(callback, 16);
  return () => clearTimeout(timer);
}

/**
 * The index of the oldest item drawn. A session that opens starts with its newest `FIRST_ROWS`
 * items; older ones follow in steps of `BACKFILL_ROWS` while the window is idle, as transitions,
 * so typing, streaming and scrolling go first. New items are always drawn.
 */
function useFirstRow(view: TranscriptView): number {
  const total = view.items.length;
  const [drawn, setDrawn] = useState<{ sessionId: string; first: number } | null>(null);
  let first = total;
  if (drawn !== null && drawn.sessionId === view.sessionId && drawn.first <= total) {
    first = drawn.first;
  } else if (view.loaded) {
    // Opened, or its transcript was replaced: the newest items now, the rest after.
    first = Math.max(0, total - FIRST_ROWS);
    setDrawn({ sessionId: view.sessionId, first });
  }

  useEffect(() => {
    if (drawn === null || drawn.first === 0) return;
    const { sessionId } = drawn;
    return whenIdle(() => {
      startTransition(() => {
        setDrawn((current) => {
          if (current === null || current.sessionId !== sessionId) return current;
          const next = Math.floor((current.first - BACKFILL_ROWS) / GROUP_SIZE) * GROUP_SIZE;
          return { sessionId, first: Math.max(0, next) };
        });
      });
    });
  }, [drawn]);

  return first;
}

/** Permission items by request id; the same map while they are the same items. */
function usePermissions(items: readonly TranscriptItem[]): ReadonlyMap<string, PermissionItem> {
  const last = useRef<{ list: PermissionItem[]; map: Map<string, PermissionItem> } | null>(null);
  return useMemo(() => {
    const list: PermissionItem[] = [];
    for (const item of items) if (item.kind === "permission") list.push(item);
    const previous = last.current;
    if (
      previous &&
      previous.list.length === list.length &&
      previous.list.every((p, i) => p === list[i])
    ) {
      return previous.map;
    }
    const map = new Map(list.map((item) => [item.requestId, item]));
    last.current = { list, map };
    return map;
  }, [items]);
}

export function Transcript(props: TranscriptProps) {
  const { view, sessionId, homeDir, autoFocusPendingCard } = props;

  // The app shell may pass new callback functions on every render; items are memoised, so they
  // get one stable environment whose functions call the latest props.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const hasOpenInChanges = props.onOpenInChanges !== undefined;
  const hasReview = props.onReviewProjectCode !== undefined;
  const hasSubagents = props.onOpenSubagent !== undefined;
  const env = useMemo<TranscriptEnv>(
    () => ({
      cwd: view.cwd,
      homeDir,
      setItemOpen: (itemId, open) => latest.current.onSetItemOpen(itemId, open),
      showCardAgain: (requestId, shown) => latest.current.onShowCardAgain(requestId, shown),
      respondPermission: (requestId, response) =>
        latest.current.onRespondPermission(requestId, response),
      respondQuestion: (requestId, response) =>
        latest.current.onRespondQuestion(requestId, response),
      respondPlan: (requestId, response) => latest.current.onRespondPlan(requestId, response),
      openLink: (url) => latest.current.onOpenLink(url),
      openInChanges: hasOpenInChanges
        ? (filePath) => latest.current.onOpenInChanges?.(filePath)
        : null,
      reviewProjectCode: hasReview
        ? (projectDir) => latest.current.onReviewProjectCode?.(projectDir)
        : null,
      openSubagent: hasSubagents ? (agentId) => latest.current.onOpenSubagent?.(agentId) : null,
    }),
    [view.cwd, homeDir, hasOpenInChanges, hasReview, hasSubagents],
  );

  const permissions = usePermissions(view.items);
  const forkView = props.fork ?? null;
  const hasOpenOriginal = props.onOpenOriginal !== undefined;
  const beforeItemId = useMemo(() => forkPlace(view.items, forkView), [view.items, forkView]);
  const fork = useMemo<RowContext["fork"]>(
    () =>
      forkView === null
        ? null
        : {
            view: forkView,
            beforeItemId,
            onOpen: hasOpenOriginal ? () => latest.current.onOpenOriginal?.() : null,
          },
    [forkView, beforeItemId, hasOpenOriginal],
  );
  const context = useMemo<RowContext>(
    () => ({
      openItems: view.openItems,
      shownAgain: view.shownAgain,
      toolCallDisplay: view.toolCallDisplay,
      activeTurnId: view.activeTurnId,
      queuedTurnIds: view.queuedTurnIds,
      permissions,
      autoFocusPendingCard,
      fork,
    }),
    [
      view.openItems,
      view.shownAgain,
      view.toolCallDisplay,
      view.activeTurnId,
      view.queuedTurnIds,
      permissions,
      autoFocusPendingCard,
      fork,
    ],
  );
  const first = useFirstRow(view);

  const reducedMotion = useReducedMotion();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const follow = useFollowOutput(scrollerRef, columnRef, { reducedMotion, resetKey: sessionId });
  const announcement = useAnnouncements(view);

  const total = view.items.length;
  const groups: ReactNode[] = [];
  for (let group = Math.floor(first / GROUP_SIZE); group * GROUP_SIZE < total; group++) {
    const from = Math.max(first, group * GROUP_SIZE);
    const to = Math.min(total, (group + 1) * GROUP_SIZE);
    groups.push(
      <RowGroup key={group} items={view.items.slice(from, to)} context={context} env={env} />,
    );
  }

  const empty = view.loaded && view.items.length === 0 && view.promptProgress === null;
  return (
    // Not a landmark of its own: the window's main area is one, and the log inside is named
    // "Transcript", so VoiceOver says the name once.
    <div className={styles.transcript} data-session={sessionId}>
      <div
        ref={scrollerRef}
        className={styles.scroller}
        role="log"
        aria-live="off"
        aria-label="Transcript"
        aria-busy={!view.loaded}
        onScroll={follow.onScroll}
        onWheel={follow.onWheel}
      >
        <div ref={columnRef} className={styles.column}>
          {!view.loaded ? (
            <p className={styles.quiet}>
              <Spinner size={12} />
              Loading the conversation…
            </p>
          ) : empty ? (
            <p className={styles.quiet}>Nothing here yet. Send a message below to start.</p>
          ) : (
            groups
          )}
          {view.loaded && fork !== null && fork.beforeItemId === null && (
            <ForkMarker view={fork.view} onOpen={fork.onOpen} />
          )}
          {view.promptProgress && <PromptProgress progress={view.promptProgress} />}
        </div>
      </div>
      {follow.showJump && (
        <div className={styles.jump}>
          <Button size="sm" icon="chevron-down" onClick={follow.jumpToLatest}>
            Jump to latest
          </Button>
        </div>
      )}
      <div className="vh" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
