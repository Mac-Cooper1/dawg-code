/**
 * "Plan ready for review": the proposed plan as Markdown, with approve, approve and accept edits,
 * and keep planning with feedback.
 */
import type { PlanResponse } from "@dawg/protocol";
import { memo, useEffect, useId, useRef, useState } from "react";
import { displayPath } from "../lib/format.ts";
import { MODE_INFO } from "../lib/modes.ts";
import { Markdown } from "../markdown/index.ts";
import type { PlanItem } from "../state/types.ts";
import type { TranscriptEnv } from "../transcript/env.ts";
import { Button } from "../ui/index.ts";
import styles from "./DecisionCard.module.css";
import { DecisionFrame, DecisionRecord, useFocusOnAppear } from "./DecisionFrame.tsx";
import { planRecord } from "./records.ts";

function PlanBox({ item, env }: { item: PlanItem; env: TranscriptEnv }) {
  return (
    <section
      className={styles.plan}
      aria-label="Plan"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the plan scrolls; keyboard users need to reach it
      tabIndex={0}
    >
      <Markdown text={item.plan} onOpenLink={env.openLink} />
    </section>
  );
}

function PathAside({ item, env }: { item: PlanItem; env: TranscriptEnv }) {
  if (!item.planPath) return null;
  return (
    <span className={styles.aside} title={item.planPath}>
      {displayPath(item.planPath, env.cwd, env.homeDir)}
    </span>
  );
}

function PendingPlan({
  item,
  env,
  autoFocus,
}: {
  item: PlanItem;
  env: TranscriptEnv;
  autoFocus: boolean;
}) {
  const [mode, setMode] = useState<"main" | "feedback">("main");
  const [feedback, setFeedback] = useState("");
  const [sent, setSent] = useState(false);
  const approveRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const feedbackId = useId();
  useFocusOnAppear(approveRef, autoFocus);

  const focusAfterSwitch = useRef(false);
  useEffect(() => {
    if (!focusAfterSwitch.current) return;
    focusAfterSwitch.current = false;
    (mode === "feedback" ? feedbackRef.current : keepRef.current)?.focus();
  }, [mode]);

  const respond = (response: PlanResponse) => {
    if (sent) return;
    setSent(true);
    env.respondPlan(item.requestId, response);
  };
  const approve = () => respond({ decision: "approve" });
  const approveWithEdits = () => respond({ decision: "approve", mode: "acceptEdits" });
  const openFeedback = () => {
    focusAfterSwitch.current = true;
    setMode("feedback");
  };
  const back = () => {
    focusAfterSwitch.current = true;
    setMode("main");
  };
  const sendFeedback = () => {
    const message = feedback.trim();
    if (message) respond({ decision: "reject", message });
  };

  const shortcuts =
    mode === "main"
      ? { primary: approve, secondary: approveWithEdits, escape: openFeedback }
      : { primary: null, secondary: sendFeedback, escape: back };
  const before = item.modeBeforePlan;

  return (
    <DecisionFrame
      icon="plan"
      heading="Plan ready for review"
      aside={<PathAside item={item} env={env} />}
      label="Plan ready for review"
      shortcuts={sent ? null : shortcuts}
    >
      <PlanBox item={item} env={env} />
      {mode === "main" ? (
        <div className={styles.stack}>
          <div className={styles.actions}>
            <Button
              ref={approveRef}
              variant="primary"
              kbd="⏎"
              aria-keyshortcuts="Enter"
              disabled={sent}
              onClick={approve}
            >
              Approve
            </Button>
            <Button
              kbd="⌘⏎"
              aria-keyshortcuts="Meta+Enter"
              disabled={sent}
              onClick={approveWithEdits}
            >
              Approve and accept edits
            </Button>
            <Button
              ref={keepRef}
              variant="ghost"
              kbd="esc"
              aria-keyshortcuts="Escape"
              disabled={sent}
              onClick={openFeedback}
            >
              Keep planning…
            </Button>
          </div>
          {before && before !== "plan" && (
            <p className={styles.hint}>
              Approve returns to {MODE_INFO[before].label}, the mode you were in before planning.
            </p>
          )}
        </div>
      ) : (
        <div className={styles.stack}>
          <label className={styles.fieldLabel} htmlFor={feedbackId}>
            What should change?
          </label>
          <textarea
            ref={feedbackRef}
            id={feedbackId}
            className={styles.field}
            rows={2}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <div className={styles.actions}>
            <Button
              variant="primary"
              kbd="⌘⏎"
              aria-keyshortcuts="Meta+Enter"
              disabled={sent || feedback.trim() === ""}
              onClick={sendFeedback}
            >
              Send feedback
            </Button>
            <Button variant="ghost" kbd="esc" aria-keyshortcuts="Escape" onClick={back}>
              Back
            </Button>
          </div>
        </div>
      )}
    </DecisionFrame>
  );
}

function AnsweredPlan({ item, env }: { item: PlanItem; env: TranscriptEnv }) {
  const response = item.response;
  const chosen =
    response === null
      ? null
      : response.decision === "reject"
        ? "reject"
        : response.mode === "acceptEdits"
          ? "edits"
          : "approve";
  return (
    <DecisionFrame
      icon="plan"
      heading="Plan"
      aside={<PathAside item={item} env={env} />}
      label="Plan, answered"
      shortcuts={null}
      readOnly
    >
      <PlanBox item={item} env={env} />
      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled
          aria-pressed={chosen === "approve"}
          className={chosen === "approve" ? styles.chosen : undefined}
        >
          Approve
        </Button>
        <Button
          disabled
          aria-pressed={chosen === "edits"}
          className={chosen === "edits" ? styles.chosen : undefined}
        >
          Approve and accept edits
        </Button>
        <Button
          variant="ghost"
          disabled
          aria-pressed={chosen === "reject"}
          className={chosen === "reject" ? styles.chosen : undefined}
        >
          Keep planning
        </Button>
      </div>
      {response?.decision === "reject" && response.message && (
        <p className={styles.quote}>{response.message}</p>
      )}
    </DecisionFrame>
  );
}

export interface PlanCardProps {
  item: PlanItem;
  shownAgain: boolean;
  autoFocus: boolean;
  env: TranscriptEnv;
}

export const PlanCard = memo(function PlanCard({
  item,
  shownAgain,
  autoFocus,
  env,
}: PlanCardProps) {
  if (item.state === "pending") return <PendingPlan item={item} env={env} autoFocus={autoFocus} />;
  const approved = item.response?.decision === "approve";
  return (
    <div className={styles.answered}>
      <DecisionRecord
        icon={approved ? "check" : item.state === "cancelled" ? "clock" : "plan"}
        text={planRecord(item)}
        shown={shownAgain}
        onShowAgain={(shown) => env.showCardAgain(item.requestId, shown)}
      />
      {shownAgain && <AnsweredPlan item={item} env={env} />}
    </div>
  );
});
