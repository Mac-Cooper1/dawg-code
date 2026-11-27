import { useState } from "react";
import type { DownloadState, ModelsState } from "../../shared/bridge.ts";
import { formatBytes } from "../lib/format.ts";
import { CancelDownloadDialog } from "../models/CancelDownloadDialog.tsx";
import { ProgressBar } from "../models/ProgressBar.tsx";
import { downloadAnnouncement, downloadLine, downloadPercent } from "../models/text.ts";
import { findCatalogEntry, findDownload, isRunningDownload, modelName } from "../state/models.ts";
import { Button, Icon, Spinner } from "../ui/index.ts";
import styles from "./FirstRun.module.css";

export interface DownloadStepProps {
  state: ModelsState;
  modelId: string;
  /** Why starting the download failed, when it did. */
  error: string | null;
  onPause(): void;
  /** Resume and Retry: downloads carry on from where they stopped. */
  onResume(): void;
  onCancel(): void;
  onChooseAnother(): void;
}

/** Before the first progress arrives: nothing on disk yet. */
function startingDownload(modelId: string, total: number): DownloadState {
  return {
    modelId,
    phase: "queued",
    bytesDone: 0,
    bytesTotal: total,
    bytesPerSecond: 0,
    secondsLeft: null,
    error: null,
  };
}

/** Downloading the chosen model: progress, speed and time left; pause, resume, cancel, retry. */
export function DownloadStep(props: DownloadStepProps) {
  const { state, modelId } = props;
  const [confirming, setConfirming] = useState<DownloadState | null>(null);
  const name = modelName(state, modelId);
  const entry = findCatalogEntry(state, modelId);
  const download = findDownload(state, modelId) ?? startingDownload(modelId, entry?.sizeBytes ?? 0);
  const failure = props.error ?? (download.phase === "failed" ? downloadLine(download) : null);
  const running = isRunningDownload(download);

  return (
    <>
      <div>
        <h1 className={`${styles.h1} ${styles.h1Step}`}>Downloading {name}</h1>
        <p className={styles.lead}>
          You can keep using your Mac. If the connection drops or you quit, it carries on from where
          it stopped.
        </p>
      </div>
      <section className={styles.feature} aria-label="Download">
        <div className={styles.percentLine}>
          <span className={styles.percent}>{downloadPercent(download)}</span>
          <span className={styles.progressText}>
            {failure === null && download.phase !== "downloading" && running && (
              <Spinner size={12} />
            )}{" "}
            {failure === null
              ? downloadLine(download)
              : `${formatBytes(download.bytesDone)} so far`}
          </span>
        </div>
        <ProgressBar download={download} label={`Downloading ${name}`} />
        {/* Read out as the phase changes and every ten percent; the line above changes too often. */}
        <p className="vh" aria-live="polite">
          {failure === null ? downloadAnnouncement(download) : ""}
        </p>
        {failure !== null && (
          <p className={styles.failure} role="alert">
            <Icon name="alert" size={14} className={styles.failureIcon} />
            {failure}
          </p>
        )}
        <div className={styles.buttons}>
          {failure !== null ? (
            <>
              <Button variant="primary" onClick={props.onResume}>
                Retry
              </Button>
              <Button variant="ghost" onClick={props.onChooseAnother}>
                Choose another model
              </Button>
            </>
          ) : (
            <>
              {download.phase === "paused" ? (
                <Button variant="primary" onClick={props.onResume}>
                  Resume
                </Button>
              ) : (
                <Button
                  disabled={!running || download.phase === "verifying"}
                  onClick={props.onPause}
                >
                  Pause
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={download.phase === "verifying"}
                onClick={() => setConfirming(download)}
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      </section>
      <CancelDownloadDialog
        download={confirming}
        name={name}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        onConfirm={() => {
          setConfirming(null);
          props.onCancel();
        }}
      />
    </>
  );
}
