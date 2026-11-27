import type { DiffHunk } from "@dawg/protocol";
import { type CSSProperties, memo, useMemo, useState } from "react";
import styles from "./Lines.module.css";
import { type DiffRow, diffRows, plural } from "./toolInfo.ts";

/** Rows drawn at first; a very large diff shows the rest on request so the window stays quick. */
const INITIAL_ROWS = 400;

const ROW_CLASS: Record<DiffRow["kind"], string | undefined> = {
  hunk: styles.hunk,
  context: undefined,
  add: styles.add,
  del: styles.del,
  note: styles.note,
};

function numberWidth(rows: readonly DiffRow[]): string {
  let max = 0;
  for (const row of rows) if (row.number !== null && row.number > max) max = row.number;
  return `${Math.max(3, String(max).length) + 2}ch`;
}

/**
 * An inline unified diff: a header row per hunk, then context, removed and added lines with
 * their line numbers (the old file's for removed lines, the new file's otherwise).
 */
export const DiffView = memo(function DiffView({
  hunks,
  compact = false,
}: {
  hunks: readonly DiffHunk[];
  /** A lower maximum height, for decision cards. */
  compact?: boolean;
}) {
  const rows = useMemo(() => diffRows(hunks), [hunks]);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, INITIAL_ROWS);
  const style = { "--number-width": numberWidth(rows) } as CSSProperties;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls; these are lines of a diff
    <div
      className={compact ? `${styles.lines} ${styles.compact}` : styles.lines}
      style={style}
      role="group"
      aria-label={`Diff, ${plural(rows.length, "line")}`}
    >
      {shown.map((row, index) => (
        <div
          // Rows are positional within an immutable diff.
          // biome-ignore lint/suspicious/noArrayIndexKey: the diff never reorders
          key={index}
          className={ROW_CLASS[row.kind] ? `${styles.row} ${ROW_CLASS[row.kind]}` : styles.row}
          data-kind={row.kind}
        >
          {row.kind === "hunk" || row.kind === "note" ? (
            <span className={styles.text}>{row.text}</span>
          ) : (
            <>
              <span className={styles.number}>{row.number}</span>
              <span className={styles.sign}>{row.sign}</span>
              <span className={styles.text}>
                {row.sign === "+" && <span className={styles.srOnly}>Added: </span>}
                {row.sign === "-" && <span className={styles.srOnly}>Removed: </span>}
                {row.text}
              </span>
            </>
          )}
        </div>
      ))}
      {rows.length > shown.length && (
        <button type="button" className={styles.more} onClick={() => setShowAll(true)}>
          Show all {plural(rows.length, "line")}
        </button>
      )}
    </div>
  );
});
