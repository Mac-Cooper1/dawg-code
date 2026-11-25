import type { DownloadState } from "../../shared/bridge.ts";
import { formatBytes } from "../lib/format.ts";
import { ConfirmDialog } from "../ui/index.ts";

/** Asks before a download is cancelled: cancelling deletes what it fetched; pausing keeps it. */
export function CancelDownloadDialog(props: {
  download: DownloadState | null;
  name: string;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}) {
  const done = props.download?.bytesDone ?? 0;
  return (
    <ConfirmDialog
      open={props.download !== null}
      onOpenChange={props.onOpenChange}
      title={`Cancel the download of ${props.name}?`}
      confirmLabel="Cancel download"
      cancelLabel="Keep downloading"
      destructive
      onConfirm={props.onConfirm}
    >
      <p>
        {done === 0
          ? "Nothing has been downloaded yet."
          : props.download?.phase === "paused"
            ? `The ${formatBytes(done)} downloaded so far is deleted.`
            : `The ${formatBytes(done)} downloaded so far is deleted. Pause keeps it instead.`}
      </p>
    </ConfirmDialog>
  );
}
