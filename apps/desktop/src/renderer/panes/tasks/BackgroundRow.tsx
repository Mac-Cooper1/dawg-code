import type { BackgroundTask, SessionId } from "@dawg/protocol";
import { memo, useId, useLayoutEffect, useRef, useState } from "react";
import type { AppActions } from "../../state/types.ts";
import { Button, ConfirmDialog, Icon } from "../../ui/index.ts";
import { oneLine, ranText, statusText } from "./background.ts";
import styles from "./Tasks.module.css";
import { useBackgroundOutput } from "./useBackgroundOutput.ts";

function StatusMark({ status }: { status: BackgroundTask["status"] }) {
  return (
    <span className={styles.mark} data-status={status} aria-hidden="true">
      {status === "running" && <span className={styles.spin} />}
      {status === "completed" && <Icon name="check" size={14} />}
      {status === "failed" && <Icon name="alert" size={14} />}
      {status === "stopped" && <Icon name="stop" size={12} />}
    </span>
  );
}

/** The output viewer: plain text, kept scrolled to the end while it was at the end. */
function OutputLog(props: {
  id: string;
  sessionId: SessionId;
  task: BackgroundTask;
  read: AppActions["readBackgroundOutput"];
}) {
  const { task } = props;
  const output = useBackgroundOutput(props.read, props.sessionId, task.taskId, {
    open: true,
    running: task.status === "running",
  });
  const logRef = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (log && atEnd.current) log.scrollTop = log.scrollHeight;
  });

  const empty = !output.loading && output.text === "";
  return (
    <div id={props.id} className={styles.output}>
      {output.truncated && <p className={styles.outputNote}>Showing the end of the output.</p>}
      {output.error !== null && (
        <p className={styles.outputNote} data-tone="error" role="alert">
          Could not read the output. {output.error}
        </p>
      )}
      <pre
        ref={logRef}
        className={styles.log}
        role="log"
        aria-label={`Output of ${oneLine(task.command)}`}
        aria-busy={output.loading}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the output scrolls; keyboard users need to reach it
        tabIndex={0}
        onScroll={(event) => {
          const log = event.currentTarget;
          atEnd.current = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
        }}
      >
        {output.loading
          ? "Reading the output…"
          : empty
            ? task.status === "running"
              ? "No output yet."
              : "It wrote no output."
            : output.text}
      </pre>
    </div>
  );
}

export interface BackgroundRowProps {
  sessionId: SessionId;
  task: BackgroundTask;
  now: number;
  read: AppActions["readBackgroundOutput"];
  onStop(taskId: string): void;
}

/** One background command: what it is, how it went, its output and a Stop button. */
export const BackgroundRow = memo(function BackgroundRow(props: BackgroundRowProps) {
  const { task } = props;
  const [showOutput, setShowOutput] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const outputId = useId();
  const name = oneLine(task.command, 60);
  const ran = ranText(task);
  const description = task.description?.trim() || null;

  return (
    <li className={styles.command} aria-label={name}>
      <div className={styles.row}>
        <StatusMark status={task.status} />
        <div className={styles.info}>
          <span className={styles.commandText} title={task.command}>
            {task.command}
          </span>
          <span className={styles.meta} data-status={task.status}>
            {description !== null && `${description} · `}
            <span className={styles.status}>{statusText(task, props.now)}</span>
            {ran !== null && ` · ${ran}`}
          </span>
        </div>
        <div className={styles.actions}>
          <Button
            variant="ghost"
            size="sm"
            className={styles.actionButton}
            aria-expanded={showOutput}
            aria-controls={showOutput ? outputId : undefined}
            aria-label={showOutput ? `Hide the output of ${name}` : `Show the output of ${name}`}
            onClick={() => setShowOutput((shown) => !shown)}
          >
            Output
          </Button>
          {task.status === "running" && (
            <Button
              variant="danger"
              size="sm"
              className={styles.actionButton}
              aria-label={`Stop ${name}`}
              onClick={() => setConfirming(true)}
            >
              Stop
            </Button>
          )}
        </div>
      </div>
      {showOutput && (
        <OutputLog id={outputId} sessionId={props.sessionId} task={task} read={props.read} />
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Stop “${name}”?`}
        confirmLabel="Stop the command"
        destructive
        onConfirm={() => props.onStop(task.taskId)}
      >
        <p>This ends the command and everything it started. dawg sees that it was stopped.</p>
      </ConfirmDialog>
    </li>
  );
});
