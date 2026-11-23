/**
 * The transcript of a session: every item in order, in a centred column that follows new output
 * until the person scrolls up. Renders only what it is given (`TranscriptProps`); it never reads
 * the store.
 */
import {
  Fragment,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PermissionCard } from "../cards/PermissionCard.tsx";
import { PlanCard } from "../cards/PlanCard.tsx";
import { QuestionCard } from "../cards/QuestionCard.tsx";
import { useReducedMotion } from "../markdown/index.ts";
import type { PermissionItem, TranscriptItem, TranscriptView } from "../state/types.ts";
import { Button, Spinner } from "../ui/index.ts";
import { AssistantText } from "./AssistantText.tsx";
import { CommandOutput } from "./CommandOutput.tsx";
import { CompactionView } from "./CompactionView.tsx";
import type { TranscriptProps } from "./contract.ts";
import { Divider } from "./Divider.tsx";
import { ErrorCard } from "./ErrorCard.tsx";
import type { TranscriptEnv } from "./env.ts";
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

function renderItem(
  item: TranscriptItem,
  view: TranscriptView,
  env: TranscriptEnv,
  context: { autoFocusPendingCard: boolean },
): ReactNode {
  const opened = view.openItems[item.id];
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} env={env} />;
    case "assistant":
      return <AssistantText item={item} env={env} />;
    case "reasoning":
      return <Reasoning item={item} open={opened ?? false} env={env} />;
    case "tool":
      return (
        <ToolCard
          item={item}
          open={opened ?? defaultToolOpen(item, view.toolCallDisplay)}
          env={env}
        />
      );
    case "tasks":
      return (
        <TasksCard
          item={item}
          running={view.activeTurnId !== null && item.turnId === view.activeTurnId}
          open={opened ?? false}
          env={env}
        />
      );
    case "permission":
      return (
        <PermissionCard
          item={item}
          shownAgain={view.shownAgain[item.requestId] ?? false}
          autoFocus={context.autoFocusPendingCard}
          env={env}
        />
      );
    case "question":
      return (
        <QuestionCard
          item={item}
          shownAgain={view.shownAgain[item.requestId] ?? false}
          autoFocus={context.autoFocusPendingCard}
          env={env}
        />
      );
    case "plan":
      return (
        <PlanCard
          item={item}
          shownAgain={view.shownAgain[item.requestId] ?? false}
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
  }
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
    }),
    [view.cwd, homeDir, hasOpenInChanges],
  );

  const permissions = useMemo(() => {
    const map = new Map<string, PermissionItem>();
    for (const item of view.items) if (item.kind === "permission") map.set(item.requestId, item);
    return map;
  }, [view.items]);

  const reducedMotion = useReducedMotion();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const follow = useFollowOutput(scrollerRef, columnRef, { reducedMotion, resetKey: sessionId });
  const announcement = useAnnouncements(view);

  const context = { autoFocusPendingCard };
  const rows: ReactNode[] = [];
  for (const item of view.items) {
    if (item.kind === "tool" && isToolHidden(item.permissionRequestId, permissions)) continue;
    if (item.kind === "user" && item.turnId !== null && view.queuedTurnIds[item.turnId]) {
      rows.push(<Divider key={`${item.id}:queued`} text="Queued message sent" />);
    }
    rows.push(<Fragment key={item.id}>{renderItem(item, view, env, context)}</Fragment>);
  }

  const empty = view.loaded && view.items.length === 0 && view.promptProgress === null;
  return (
    <section className={styles.transcript} aria-label="Transcript" data-session={sessionId}>
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
            rows
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
    </section>
  );
}
