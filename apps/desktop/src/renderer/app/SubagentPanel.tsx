/**
 * A subagent's own transcript, shown in place of its session's: read-only (no composer), in the
 * same transcript component, under a bar with the agent's type and task, how it is doing, and a
 * way back. Esc goes back too, unless something inside handles it first.
 *
 * Going back puts focus on the agent card's "Open transcript" button, so the person is where
 * they left off.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { agentPlacement, agentStatusText } from "../lib/agents.ts";
import type { SubagentPanelView } from "../state/types.ts";
import { Transcript } from "../transcript/Transcript.tsx";
import { focusMessageField } from "../ui/focus.ts";
import { Button } from "../ui/index.ts";
import styles from "./App.module.css";
import { isInOverlay } from "./commands/dispatch.ts";
import { isTypingTarget } from "./commands/keys.ts";
import panel from "./SubagentPanel.module.css";

export interface SubagentPanelProps {
  view: SubagentPanelView;
  homeDir: string;
  onClose(): void;
  onRetry(): void;
  onSetItemOpen(itemId: string, open: boolean): void;
  onOpenLink(url: string): void;
}

const ignore = () => {};

/** Puts focus back on the card that opened the transcript, or in the message field. */
export function focusAgentCard(agentId: string): void {
  setTimeout(() => {
    const button = document.querySelector<HTMLButtonElement>(
      `main [data-agent-id="${CSS.escape(agentId)}"]`,
    );
    if (button) button.focus();
    else focusMessageField();
  }, 0);
}

export function SubagentPanel(props: SubagentPanelProps) {
  const { view } = props;
  const backRef = useRef<HTMLButtonElement>(null);
  const close = useRef(props.onClose);
  useLayoutEffect(() => {
    close.current = props.onClose;
  });

  // Showing the transcript moves focus to the way back, so VoiceOver reads the bar first.
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
  }, []);

  // Esc goes back. In the capture phase, so the window's Esc (stop the running turn) never sees
  // it: the session's turn waits on this agent, and stopping it is not what Esc means here.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (isTypingTarget(target) || isInOverlay(target)) return;
      const inMain = target instanceof Element && target.closest("main") !== null;
      if (!inMain && target !== document.body) return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const placement = agentPlacement(view.agent);
  return (
    <>
      <section className={panel.bar} aria-labelledby="subagent-title">
        <Button
          ref={backRef}
          variant="ghost"
          size="sm"
          className={panel.back}
          kbd="esc"
          aria-keyshortcuts="Escape"
          onClick={props.onClose}
        >
          Back to the session
        </Button>
        <div className={panel.heading}>
          <h2 id="subagent-title" className={panel.title} title={view.title}>
            {view.title}
          </h2>
          <p className={panel.status} data-status={view.agent.status}>
            {agentStatusText(view.agent)}
            {placement !== null && ` · ${placement}`}
            {" · read-only"}
          </p>
        </div>
      </section>
      <div className={styles.transcript}>
        {view.error !== null && !view.transcript?.loaded ? (
          <div className={panel.problem} role="alert">
            <p>{view.error}</p>
            <Button size="sm" onClick={props.onRetry}>
              Try again
            </Button>
          </div>
        ) : view.transcript ? (
          <Transcript
            sessionId={view.agent.sessionId}
            view={view.transcript}
            homeDir={props.homeDir}
            autoFocusPendingCard={false}
            onSetItemOpen={props.onSetItemOpen}
            onShowCardAgain={ignore}
            onRespondPermission={ignore}
            onRespondQuestion={ignore}
            onRespondPlan={ignore}
            onRespondElicitation={ignore}
            onOpenLink={props.onOpenLink}
          />
        ) : (
          <p className={styles.loading}>Loading the agent's transcript…</p>
        )}
      </div>
    </>
  );
}
