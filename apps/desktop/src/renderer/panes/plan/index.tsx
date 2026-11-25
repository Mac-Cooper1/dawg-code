/**
 * The Plan pane: the session's current or last plan, read-only, with where it stands: waiting for
 * an answer in the transcript, approved (and the mode that left plan mode in), or sent back with
 * feedback.
 */
import { displayPath } from "../../lib/format.ts";
import { MODE_INFO } from "../../lib/modes.ts";
import { Markdown } from "../../markdown/index.ts";
import { selectPlanPane } from "../../state/selectors.ts";
import { useActions, useAppStore } from "../../state/store.ts";
import type { PlanItem } from "../../state/types.ts";
import { Spinner, Tag, type TagTone } from "../../ui/index.ts";
import { PaneEmpty } from "../PaneEmpty.tsx";
import type { PaneProps } from "../types.ts";
import styles from "./Plan.module.css";

export interface PlanStatus {
  /** "Waiting for you", "Approved", "Rejected", "Not answered". */
  label: string;
  tone: TagTone;
  /** A sentence on what happens or happened next. */
  detail: string;
  /** The feedback sent with a rejection. */
  feedback: string | null;
}

/** Where a plan stands, in words. */
export function planStatus(item: PlanItem): PlanStatus {
  const before = item.modeBeforePlan;
  const returnsTo = before && before !== "plan" ? MODE_INFO[before].label : null;
  if (item.state === "pending") {
    return {
      label: "Waiting for you",
      tone: "amber",
      detail: returnsTo
        ? `Answer it in the transcript. Approve returns to ${returnsTo}; Approve and accept edits switches to Accept edits.`
        : "Answer it in the transcript. Approve and accept edits switches to Accept edits.",
      feedback: null,
    };
  }
  if (item.state === "cancelled") {
    return {
      label: "Not answered",
      tone: "neutral",
      detail: "The turn ended before the plan was answered.",
      feedback: null,
    };
  }
  const response = item.response;
  if (response?.decision === "reject") {
    return {
      label: "Rejected",
      tone: "red",
      detail: "You asked for changes, so dawg kept planning.",
      feedback: response.message?.trim() || null,
    };
  }
  const mode = response?.mode ?? (before && before !== "plan" ? before : null);
  return {
    label: "Approved",
    tone: "green",
    detail: mode ? `Approved. It left plan mode for ${MODE_INFO[mode].label}.` : "Approved.",
    feedback: null,
  };
}

export function PlanPane({ sessionId }: PaneProps) {
  const view = useAppStore((state) => selectPlanPane(state, sessionId));
  const homeDir = useAppStore((state) => state.homeDir);
  const actions = useActions();

  if (view?.plan == null) {
    if (view && !view.loaded) {
      return (
        <div className={styles.loading} role="status">
          <Spinner size={14} />
          Loading the session…
        </div>
      );
    }
    return (
      <PaneEmpty pane="plan" title="No plan in this session">
        Switch to Plan mode with ⇧⇥ to have dawg plan before it changes anything. The plan shows
        here, read-only.
      </PaneEmpty>
    );
  }

  const { plan } = view;
  const status = planStatus(plan);
  return (
    <article className={styles.pane} aria-label="Plan">
      <header className={styles.header}>
        <Tag tone={status.tone}>{status.label}</Tag>
        {view.planCount > 1 && (
          <span className={styles.count}>Latest of {view.planCount} plans</span>
        )}
        <span className={styles.grow} />
        {plan.planPath && (
          <span className={styles.path} title={plan.planPath}>
            {displayPath(plan.planPath, view.cwd, homeDir)}
          </span>
        )}
      </header>
      <div className={styles.status}>
        <p className={styles.detail}>{status.detail}</p>
        {status.feedback !== null && (
          <blockquote className={styles.feedback}>
            <span className="vh">Your feedback: </span>
            {status.feedback}
          </blockquote>
        )}
      </div>
      <div className={styles.body}>
        <Markdown text={plan.plan} onOpenLink={(url) => void actions.openExternal(url)} />
      </div>
    </article>
  );
}
