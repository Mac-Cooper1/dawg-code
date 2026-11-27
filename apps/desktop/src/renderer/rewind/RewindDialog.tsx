/**
 * The rewind dialog (Phase 4, "Checkpoints and rewind"): Esc twice in the composer, `/rewind`,
 * or the palette's "Rewind to an earlier point…". It lists the session's checkpoints, newest
 * first: each of the person's messages, when it was sent and the files its turn changed. Choosing
 * one offers what to restore: the files and the conversation, the conversation (a fork the window
 * moves to; the original stays as it was), the files, or a summary of everything from there.
 *
 * Keyboard first: ↑ and ↓ move through the list and ⏎ chooses; 1 to 4 pick an action; Esc goes
 * back a step, then closes. Shown while the store's `rewind` is set.
 */
import type { Checkpoint, RewindAction } from "@dawg/protocol";
import { Dialog } from "radix-ui";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { run } from "../app/run.ts";
import { displayPath, formatRelativeTime, truncate } from "../lib/format.ts";
import { useActions, useAppStore } from "../state/store.ts";
import type { RewindDialog as RewindState } from "../state/types.ts";
import { Button, Icon, Kbd, Spinner } from "../ui/index.ts";
import styles from "./RewindDialog.module.css";

/** Said in the dialog: shell commands are not tracked, as in Claude Code. */
export const SHELL_CAVEAT =
  "Only changes made by dawg’s file tools are tracked. Changes made by shell commands are not; the Changes pane shows everything git sees.";

interface ActionInfo {
  action: RewindAction;
  label: string;
  detail: string;
}

/** The actions for a checkpoint, in Claude Code's order; the file ones only with files to put back. */
export function actionsFor(checkpoint: Checkpoint): ActionInfo[] {
  const withFiles = checkpoint.restore.length > 0;
  const all: (ActionInfo | null)[] = [
    withFiles
      ? {
          action: "both",
          label: "Restore files and conversation",
          detail: "Put the files back and go on from just before this message, in a fork.",
        }
      : null,
    {
      action: "conversation",
      label: "Restore conversation",
      detail:
        "Go on from just before this message, in a fork. The files stay as they are; the original conversation is kept.",
    },
    withFiles
      ? {
          action: "files",
          label: "Restore files",
          detail: "Put the files back as they were before this message. The conversation goes on.",
        }
      : null,
    {
      action: "summarize",
      label: "Summarise from here",
      detail:
        "Replace this message and everything after it with a summary, to free context. Files are not changed.",
    },
  ];
  return all.filter((a): a is ActionInfo => a !== null);
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** "14:05" today, "Yesterday 14:05", "Mon 14:05", else the sidebar's date. */
export function checkpointTime(time: number, now: number): string {
  const relative = formatRelativeTime(time, now);
  if (relative === "now" || /^\d+[mh]$/.test(relative)) return clock.format(time);
  if (relative === "Yesterday" || /^[A-Z][a-z]{2}$/.test(relative)) {
    return `${relative} ${clock.format(time)}`;
  }
  return relative;
}

/** Who changed a file in a checkpoint, when subagents did: "agent-1 (general-purpose)". */
function agentsText(agents: Checkpoint["files"][number]["agents"]): string {
  return agents.map((a) => `${a.agentId} (${a.agentType})`).join(", ");
}

/**
 * The subagents that changed each file from a checkpoint on: those of its own turn and of
 * every later one (`checkpoints` is newest first, so the later ones come before it).
 */
function agentsFrom(
  checkpoints: readonly Checkpoint[],
  chosen: Checkpoint,
): Map<string, Checkpoint["files"][number]["agents"]> {
  const out = new Map<string, Checkpoint["files"][number]["agents"]>();
  const upTo = checkpoints.indexOf(chosen);
  for (const checkpoint of checkpoints.slice(0, upTo < 0 ? 0 : upTo + 1)) {
    for (const file of checkpoint.files) {
      if (file.agents.length === 0) continue;
      const seen = out.get(file.path) ?? [];
      const more = file.agents.filter((a) => !seen.some((b) => b.agentId === a.agentId));
      out.set(file.path, [...seen, ...more]);
    }
  }
  return out;
}

/** One line about a checkpoint's files. */
function filesLine(checkpoint: Checkpoint): string {
  if (!checkpoint.tracked) return "Its file changes are no longer kept";
  const count = checkpoint.files.length;
  if (count === 0) return "No file changes";
  return count === 1 ? "Changed 1 file" : `Changed ${count} files`;
}

export interface RewindDialogProps {
  dialog: RewindState;
  /** The session's working directory and the home folder, to show paths short. */
  cwd: string;
  homeDir: string;
  now: number;
  onRewind(
    checkpointId: string,
    action: RewindAction,
    options: { overwrite?: boolean; instructions?: string },
  ): void;
  /** Reads the checkpoints again, after they could not be read. */
  onRetry(): void;
  /** Leaves the question about files changed outside dawg, back to the actions. */
  onDismissConflict(): void;
  onClose(): void;
  onOpenChanges(): void;
}

type Step = { kind: "list" } | { kind: "actions"; checkpoint: Checkpoint };

export function RewindDialog(props: RewindDialogProps) {
  const { dialog } = props;
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [active, setActive] = useState(0);
  const [instructions, setInstructions] = useState("");
  const listId = useId();
  const descriptionId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);
  const working = dialog.phase === "working";
  const conflict = dialog.phase === "conflicts" ? dialog.conflict : null;
  const shortPath = (file: string) => displayPath(file, props.cwd, props.homeDir);
  const options = useMemo(
    () => dialog.checkpoints.map((checkpoint, index) => ({ checkpoint, id: `${listId}-${index}` })),
    [dialog.checkpoints, listId],
  );
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));

  // Focus follows the step: the list, then the first action.
  useEffect(() => {
    if (step.kind === "list" && dialog.phase === "ready") listRef.current?.focus();
    if (step.kind === "actions" && dialog.phase === "ready") firstAction.current?.focus();
  }, [step, dialog.phase]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    setActive(index);
    setInstructions("");
    setStep({ kind: "actions", checkpoint: option.checkpoint });
  };

  /** Esc and Back: from the question about changed files to the actions, then the list, then out. */
  const back = () => {
    if (working) return;
    if (conflict !== null) props.onDismissConflict();
    else if (step.kind === "actions") setStep({ kind: "list" });
    else props.onClose();
  };

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (options.length === 0) return;
    const last = options.length - 1;
    const move: Record<string, number> = {
      ArrowDown: Math.min(last, activeIndex + 1),
      ArrowUp: Math.max(0, activeIndex - 1),
      Home: 0,
      End: last,
      PageDown: Math.min(last, activeIndex + 5),
      PageUp: Math.max(0, activeIndex - 5),
    };
    const next = move[event.key];
    if (next !== undefined) {
      event.preventDefault();
      setActive(next);
      document.getElementById(options[next]?.id ?? "")?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(activeIndex);
    }
  };

  const go = (checkpoint: Checkpoint, action: RewindAction) => {
    const text = instructions.trim();
    props.onRewind(
      checkpoint.id,
      action,
      action === "summarize" && text !== "" ? { instructions: text } : {},
    );
  };

  const onActionsKey = (event: KeyboardEvent<HTMLElement>, checkpoint: Checkpoint) => {
    if (event.target instanceof HTMLTextAreaElement || working) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = Number(event.key) - 1;
    const list = actionsFor(checkpoint);
    const picked = Number.isInteger(index) ? list[index] : undefined;
    if (picked === undefined) return;
    event.preventDefault();
    go(checkpoint, picked.action);
  };

  let body: ReactNode;
  if (dialog.phase === "loading") {
    body = (
      <p className={styles.status} role="status">
        <Spinner size={12} /> Reading the checkpoints…
      </p>
    );
  } else if (dialog.phase === "failed") {
    body = (
      <div className={styles.status}>
        <p className={styles.error} role="alert">
          {dialog.error ?? "The checkpoints could not be read."}
        </p>
        <div className={styles.actionsRow}>
          <Button onClick={props.onClose}>Close</Button>
          <Button variant="primary" onClick={props.onRetry}>
            Try again
          </Button>
        </div>
      </div>
    );
  } else if (conflict !== null) {
    body = (
      <section className={styles.step} aria-labelledby={`${listId}-conflicts`}>
        <h3 id={`${listId}-conflicts`} className={styles.stepTitle}>
          These files changed outside dawg since
        </h3>
        <p className={styles.text}>
          You, another program or a shell command changed them after dawg last wrote them. Restoring
          puts back dawg’s saved copy and loses those changes.
        </p>
        <ul className={styles.fileList} aria-label="Files changed outside dawg">
          {conflict.files.map((file) => (
            <li key={file} className={styles.file}>
              <Icon name="alert" size={12} className={styles.warn} />
              <span className={styles.path}>{shortPath(file)}</span>
            </li>
          ))}
        </ul>
        <div className={styles.actionsRow}>
          <Button onClick={back}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={() =>
              props.onRewind(conflict.checkpointId, conflict.action, {
                overwrite: true,
                ...(conflict.instructions === null ? {} : { instructions: conflict.instructions }),
              })
            }
          >
            Overwrite them
          </Button>
        </div>
      </section>
    );
  } else if (step.kind === "actions") {
    const { checkpoint } = step;
    const list = actionsFor(checkpoint);
    const byAgents = agentsFrom(dialog.checkpoints, checkpoint);
    const writes = checkpoint.restore.filter((s) => s.action === "write");
    const deletes = checkpoint.restore.filter((s) => s.action === "delete");
    body = (
      // Number keys pick an action from anywhere in the step.
      <fieldset
        className={styles.step}
        onKeyDown={(event) => onActionsKey(event, checkpoint)}
        aria-labelledby={`${listId}-chosen`}
      >
        <p id={`${listId}-chosen`} className={styles.chosen}>
          <span className={styles.chosenLabel}>Before</span>{" "}
          <q className={styles.prompt}>
            {truncate(checkpoint.prompt.replace(/\s+/g, " ").trim() || "(no text)", 160)}
          </q>{" "}
          <time className={styles.time} dateTime={new Date(checkpoint.time).toISOString()}>
            {checkpointTime(checkpoint.time, props.now)}
          </time>
        </p>
        {checkpoint.restore.length > 0 && (
          <div className={styles.preview}>
            <p className={styles.text}>
              Restoring files
              {writes.length > 0
                ? ` puts back ${writes.length === 1 ? "1 file" : `${writes.length} files`}`
                : ""}
              {writes.length > 0 && deletes.length > 0 ? " and" : ""}
              {deletes.length > 0
                ? ` removes ${deletes.length === 1 ? "1 file" : `${deletes.length} files`} made since`
                : ""}
              :
            </p>
            <ul className={styles.fileList} aria-label="Files a restore changes">
              {checkpoint.restore.map((s) => (
                <li key={s.path} className={styles.file}>
                  <span className={styles.fileAction}>
                    {s.action === "delete" ? "Remove" : "Put back"}
                  </span>
                  <span className={styles.path}>{shortPath(s.path)}</span>
                  {(byAgents.get(s.path)?.length ?? 0) > 0 && (
                    <span className={styles.agent}>
                      changed by {agentsText(byAgents.get(s.path) ?? [])}
                    </span>
                  )}
                  {s.changedOutside && (
                    <span className={styles.outside}>changed outside dawg since</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <ol className={styles.choices} aria-label="What to restore">
          {list.map((info, index) => (
            <li key={info.action} className={styles.choice}>
              <Button
                ref={index === 0 ? firstAction : undefined}
                className={styles.choiceButton}
                disabled={working}
                aria-keyshortcuts={String(index + 1)}
                aria-describedby={`${listId}-${info.action}`}
                onClick={() => go(checkpoint, info.action)}
              >
                <Kbd>{index + 1}</Kbd>
                <span className={styles.choiceLabel}>{info.label}</span>
              </Button>
              <span id={`${listId}-${info.action}`} className={styles.choiceDetail}>
                {info.detail}
              </span>
              {info.action === "summarize" && (
                <textarea
                  className={styles.instructions}
                  aria-label="What the summary should concentrate on (optional)"
                  placeholder="What the summary should concentrate on (optional)"
                  rows={2}
                  value={instructions}
                  disabled={working}
                  onChange={(event) => setInstructions(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      go(checkpoint, "summarize");
                    }
                  }}
                />
              )}
            </li>
          ))}
        </ol>
        {dialog.error !== null && (
          <p className={styles.error} role="alert">
            {dialog.error}
          </p>
        )}
        <div className={styles.actionsRow}>
          {working ? (
            <p className={styles.working} role="status">
              <Spinner size={12} /> Rewinding…
            </p>
          ) : null}
          <Button onClick={back} disabled={working}>
            Back
          </Button>
        </div>
      </fieldset>
    );
  } else if (options.length === 0) {
    body = <p className={styles.status}>Nothing to rewind to yet: send a message first.</p>;
  } else {
    body = (
      <>
        <div
          ref={listRef}
          id={listId}
          className={styles.list}
          role="listbox"
          tabIndex={0}
          aria-label="Your messages, newest first"
          aria-activedescendant={options[activeIndex]?.id}
          onKeyDown={onListKey}
        >
          {options.map(({ checkpoint, id }, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keys
            <div
              key={checkpoint.id}
              id={id}
              role="option"
              aria-selected={index === activeIndex}
              tabIndex={-1}
              className={styles.option}
              onClick={() => choose(index)}
              onMouseMove={() => setActive(index)}
            >
              <span className={styles.optionTop}>
                <span className={styles.prompt}>
                  {truncate(checkpoint.prompt.replace(/\s+/g, " ").trim() || "(no text)", 140)}
                </span>
                <time className={styles.time} dateTime={new Date(checkpoint.time).toISOString()}>
                  {checkpointTime(checkpoint.time, props.now)}
                </time>
              </span>
              <span className={styles.optionFiles}>
                {filesLine(checkpoint)}
                {checkpoint.files.length > 0 &&
                  `: ${checkpoint.files
                    .slice(0, 3)
                    .map(
                      (f) =>
                        `${shortPath(f.path)}${f.agents.length > 0 ? ` by ${agentsText(f.agents)}` : ""}`,
                    )
                    .join(", ")}${checkpoint.files.length > 3 ? ", …" : ""}`}
              </span>
            </div>
          ))}
        </div>
        <p className={styles.hint}>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move, <Kbd>⏎</Kbd> to choose, <Kbd>Esc</Kbd> to close
          {dialog.retention > 0
            ? `. Files are kept for the latest ${dialog.retention} messages.`
            : "."}
        </p>
      </>
    );
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.dialog}
          aria-describedby={descriptionId}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            back();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            listRef.current?.focus();
          }}
        >
          <Dialog.Title className={styles.title}>Rewind</Dialog.Title>
          <Dialog.Description id={descriptionId} className={styles.description}>
            Go back to the point just before one of your messages.
          </Dialog.Description>
          {body}
          <div className={styles.caveat}>
            <Icon name="alert" size={14} />
            <p className={styles.caveatText}>{SHELL_CAVEAT}</p>
            <Button size="sm" variant="ghost" onClick={props.onOpenChanges} disabled={working}>
              Open Changes
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The dialog, connected to the store: shown while `rewind` is set. */
export function RewindDialogContainer() {
  const dialog = useAppStore((state) => state.rewind);
  const cwd = useAppStore((state) =>
    state.rewind === null ? "" : (state.sessions[state.rewind.sessionId]?.summary.cwd ?? ""),
  );
  const homeDir = useAppStore((state) => state.homeDir);
  const actions = useActions();
  if (dialog === null) return null;
  return (
    <RewindDialog
      key={dialog.sessionId}
      dialog={dialog}
      cwd={cwd}
      homeDir={homeDir}
      now={Date.now()}
      onRewind={(checkpointId, action, options) =>
        run(actions.rewind(checkpointId, action, options))
      }
      onRetry={() => run(actions.openRewind(dialog.sessionId))}
      onDismissConflict={() => actions.dismissRewindConflict()}
      onClose={() => actions.closeRewind()}
      onOpenChanges={() => {
        actions.closeRewind();
        actions.openPane("changes");
      }}
    />
  );
}
