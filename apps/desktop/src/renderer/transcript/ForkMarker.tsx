/**
 * Where a forked session's own conversation starts (Phase 4, rewind): "Rewound from “Fix the
 * split”" just before its first new message, or at the end while it has none; a plain fork says
 * "Forked from". The original is kept, and a button opens it.
 */
import type { ForkPoint, SessionId } from "@dawg/protocol";
import { Button, Icon } from "../ui/index.ts";
import styles from "./ForkMarker.module.css";

export interface ForkMarkerView {
  /** The session it was forked from. */
  originalId: SessionId;
  /** Its title, or null when it has none or is not known here. */
  originalTitle: string | null;
  /** Whether the original is in the sidebar, so it can be opened. */
  originalShown: boolean;
  point: ForkPoint;
}

/**
 * The marker's place: before the first message of a turn the fork made itself. For a fork from
 * before a turn (`turn-<n>`), the copied turns are those numbered below n; otherwise null, and
 * the marker goes first.
 */
export function forkBoundary(point: ForkPoint): number | null {
  if (point.position !== "beforeTurn") return null;
  const match = /^turn-(\d+)$/.exec(point.turnId);
  return match ? Number(match[1]) : null;
}

/** The number in a `turn-<n>` id, or null. */
export function turnNumber(turnId: string | null): number | null {
  const match = turnId === null ? null : /^turn-(\d+)$/.exec(turnId);
  return match ? Number(match[1]) : null;
}

export function forkMarkerText(view: ForkMarkerView): string {
  const title =
    view.originalTitle === null ? "the original conversation" : `“${view.originalTitle}”`;
  return view.point.position === "beforeTurn"
    ? `Rewound from ${title}. The conversation goes on from here; the original is kept.`
    : `Forked from ${title}. The messages above are copied from it.`;
}

export function ForkMarker(props: { view: ForkMarkerView; onOpen: (() => void) | null }) {
  const { view } = props;
  return (
    <div className={styles.marker} role="note" data-fork-marker="">
      <span className={styles.line} aria-hidden="true" />
      <span className={styles.text}>
        <Icon name="fork" size={14} />
        <span>{forkMarkerText(view)}</span>
        {props.onOpen !== null && view.originalShown && (
          <Button size="sm" variant="ghost" onClick={props.onOpen}>
            Open the original
          </Button>
        )}
      </span>
      <span className={styles.line} aria-hidden="true" />
    </div>
  );
}
