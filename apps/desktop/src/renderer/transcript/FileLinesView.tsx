import type { CSSProperties } from "react";
import styles from "./Lines.module.css";
import type { FileLines } from "./toolInfo.ts";

/** Lines of a file with their numbers, as a Read card shows them. */
export function FileLinesView({ file, count }: { file: FileLines; count: number }) {
  const shown = file.lines.slice(0, count);
  const last = file.start + Math.max(shown.length, 1) - 1;
  const style = { "--number-width": `${Math.max(3, String(last).length) + 2}ch` } as CSSProperties;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls; these are lines of a file
    <div
      className={styles.lines}
      style={style}
      role="group"
      aria-label={shown.length > 1 ? `Lines ${file.start}–${last}` : `Line ${file.start}`}
    >
      {shown.map((line, index) => {
        const number = file.start + index;
        return (
          <div key={number} className={styles.row}>
            <span className={styles.number}>{number}</span>
            <span className={styles.sign} />
            <span className={styles.text}>{line}</span>
          </div>
        );
      })}
    </div>
  );
}
