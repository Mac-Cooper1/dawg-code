/**
 * Starting a session in a git project: run it in the project folder, or in a new worktree of its
 * own (a separate checkout on a new branch `dawg/<name>`, made from a base branch). Shown while
 * the store's `newSessionOffer` is set; Enter starts the session.
 */
import { Dialog } from "radix-ui";
import { type FormEvent, useId, useState } from "react";
import { useActions, useAppStore } from "../state/store.ts";
import type { NewSessionOffer, WorktreeChoice } from "../state/types.ts";
import { worktreeNameProblem } from "../state/worktree-names.ts";
import { Button, Spinner } from "../ui/index.ts";
import styles from "./NewSessionDialog.module.css";
import { run } from "./run.ts";

export interface NewSessionDialogProps {
  offer: NewSessionOffer;
  /** `worktree` null: the project folder. */
  onStart(worktree: WorktreeChoice | null): void;
  onCancel(): void;
}

export function NewSessionDialog({ offer, onStart, onCancel }: NewSessionDialogProps) {
  const [worktree, setWorktree] = useState(offer.worktree);
  const [name, setName] = useState(offer.suggestedName);
  const [base, setBase] = useState(offer.current ?? offer.branches[0] ?? "");
  const [touched, setTouched] = useState(false);
  const checkId = useId();
  const nameId = useId();
  const nameHintId = useId();
  const baseId = useId();

  const trimmed = name.trim();
  const problem = worktree ? worktreeNameProblem(trimmed) : null;
  const canStart = !offer.busy && (!worktree || (problem === null && base !== ""));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!canStart) return;
    onStart(worktree ? { name: trimmed, base } : null);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !offer.busy) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog} aria-describedby={undefined}>
          <Dialog.Title className={styles.title}>New session in {offer.projectName}</Dialog.Title>
          <form className={styles.form} onSubmit={submit} noValidate>
            <div className={styles.check}>
              <input
                id={checkId}
                type="checkbox"
                checked={worktree}
                disabled={offer.busy}
                onChange={(event) => setWorktree(event.target.checked)}
              />
              <label htmlFor={checkId} className={styles.checkLabel}>
                <span className={styles.checkTitle}>Run in a worktree</span>
                <span className={styles.checkText}>
                  A separate checkout on a new branch, so this session’s changes stay apart from
                  your own work and from other sessions.
                </span>
              </label>
            </div>
            {worktree && (
              <div className={styles.fields}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor={baseId}>
                    Start from
                  </label>
                  <select
                    id={baseId}
                    className={styles.select}
                    value={base}
                    disabled={offer.busy}
                    onChange={(event) => setBase(event.target.value)}
                  >
                    {offer.branches.map((branch) => (
                      <option key={branch} value={branch}>
                        {branch === offer.current ? `${branch} (current)` : branch}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor={nameId}>
                    Worktree name
                  </label>
                  <input
                    id={nameId}
                    className={styles.input}
                    value={name}
                    disabled={offer.busy}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={touched && problem !== null}
                    aria-describedby={nameHintId}
                    onChange={(event) => setName(event.target.value)}
                    onBlur={() => setTouched(true)}
                  />
                  <p id={nameHintId} className={styles.hint}>
                    {touched && problem !== null ? (
                      <span className={styles.problem}>{problem}</span>
                    ) : (
                      <>
                        Branch <code>dawg/{trimmed || "…"}</code> in{" "}
                        <code>.dawg/worktrees/{trimmed || "…"}</code>
                      </>
                    )}
                  </p>
                </div>
              </div>
            )}
            {offer.error !== null && (
              <p className={styles.error} role="alert">
                {offer.error}
              </p>
            )}
            <div className={styles.actions}>
              <Dialog.Close asChild>
                <Button disabled={offer.busy}>Cancel</Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={!canStart} kbd="⏎">
                {offer.busy ? (
                  <>
                    <Spinner size={12} />
                    Making the worktree…
                  </>
                ) : (
                  "Start session"
                )}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The dialog, connected to the store: shown while a new session waits for its answer. */
export function NewSessionDialogContainer() {
  const offer = useAppStore((state) => state.newSessionOffer);
  const actions = useActions();
  if (offer === null) return null;
  return (
    <NewSessionDialog
      // A new offer (another project) starts from its own suggestions.
      key={`${offer.projectDir}\n${offer.suggestedName}`}
      offer={offer}
      onStart={(worktree) => run(actions.answerNewSessionOffer({ worktree }))}
      onCancel={() => run(actions.answerNewSessionOffer(null))}
    />
  );
}
