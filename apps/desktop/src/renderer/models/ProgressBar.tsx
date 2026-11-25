import type { DownloadState } from "../../shared/bridge.ts";
import styles from "./Models.module.css";
import { downloadFraction, downloadLine } from "./text.ts";

/** A download's progress bar, read by VoiceOver as "Downloading <name>, 41%". */
export function ProgressBar(props: { download: DownloadState; label: string }) {
  const { download } = props;
  const percent = Math.round(downloadFraction(download) * 100);
  return (
    <div
      className={styles.progress}
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent}%, ${downloadLine(download)}`}
      data-paused={download.phase === "paused" ? "true" : undefined}
      data-failed={download.phase === "failed" ? "true" : undefined}
    >
      <span
        className={styles.progressFill}
        style={{ width: `${downloadFraction(download) * 100}%` }}
      />
    </div>
  );
}
