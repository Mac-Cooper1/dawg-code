/**
 * The project trust dialog (Phase 4, principle 3: project-supplied code needs consent). Hooks
 * and MCP servers a project defines run commands on the person's Mac, so the engine keeps them
 * off until the person has seen them and said yes. This lists each one with what it runs and the
 * file it comes from; Approve lets exactly these run (`project.trust`), "Not now" keeps them off
 * and asks again on the next launch or when they change.
 *
 * Opened by `actions.reviewProjectCode(projectDir)`, and on its own when a session's project
 * has code waiting (see actions.ts). Shown while the store's `trustReview` is set.
 */
import type { CompatItem } from "@dawg/protocol";
import { Dialog } from "radix-ui";
import { run } from "../app/run.ts";
import { shortenPath } from "../lib/format.ts";
import { sourceLabel } from "../lib/hooks.ts";
import { isSandboxHost } from "../lib/sandbox.ts";
import { useActions, useAppStore } from "../state/store.ts";
import type { TrustReview } from "../state/types.ts";
import { Button, Icon, Spinner } from "../ui/index.ts";
import styles from "./TrustDialog.module.css";

/**
 * "hooks", "MCP servers", "hooks and MCP servers", "hooks, commands and MCP servers" and so on,
 * for the title and the text: the kinds the list holds, in that order.
 */
export function codeWords(items: readonly CompatItem[]): string {
  const has = (...kinds: CompatItem["kind"][]) => items.some((item) => kinds.includes(item.kind));
  const parts: string[] = [];
  if (has("hook")) parts.push("hooks");
  if (has("skill")) parts.push("skills");
  if (has("command")) parts.push("commands");
  if (has("mcp-server")) parts.push("MCP servers");
  // Added (Phase 4, sandbox): hosts the project opens to sandboxed commands.
  if (items.some(isSandboxHost)) parts.push("network hosts");
  if (parts.length === 0) return "code";
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export function trustTitle(review: TrustReview): string {
  const name = review.projectName;
  if (review.phase === "loading") return `Checking ${name}`;
  const approval = review.approval;
  if (approval === null || approval.items.length === 0) return `Nothing in ${name} needs approval`;
  const words = codeWords(approval.items);
  if (approval.approved && review.phase !== "saving") return `The ${words} in ${name} are approved`;
  return `Approve the ${words} in ${name}?`;
}

function kindLabel(item: CompatItem): string {
  switch (item.kind) {
    case "hook":
      return "Hook";
    case "mcp-server":
      return "MCP server";
    case "skill":
      return "Skill";
    case "command":
      return "Command";
    default:
      return isSandboxHost(item) ? "Network" : "Code";
  }
}

function ItemRow({ item, homeDir }: { item: CompatItem; homeDir: string }) {
  return (
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <span className={styles.kind}>{kindLabel(item)}</span>
        <code className={styles.name}>{item.name}</code>
      </div>
      {item.notes.length > 0 && (
        <ul className={styles.notes}>
          {item.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <p className={styles.source}>
        <code className={styles.path}>{shortenPath(item.source.path, homeDir)}</code>
        <span> · {sourceLabel(item.source)}</span>
      </p>
    </li>
  );
}

export interface TrustDialogProps {
  review: TrustReview;
  homeDir: string;
  onApprove(): void;
  /** "Not now", Esc, or Close: the code stays off. */
  onDismiss(): void;
}

export function TrustDialog({ review, homeDir, onApprove, onDismiss }: TrustDialogProps) {
  const approval = review.approval;
  const saving = review.phase === "saving";
  const waiting =
    review.phase !== "loading" &&
    approval !== null &&
    approval.items.length > 0 &&
    (!approval.approved || saving);
  const words = approval === null ? "code" : codeWords(approval.items);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onDismiss();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog}>
          <Dialog.Title className={styles.title}>
            <Icon name="shield" size={16} className={styles.titleIcon} />
            {trustTitle(review)}
          </Dialog.Title>
          <Dialog.Description asChild>
            <div className={styles.text}>
              {review.phase === "loading" ? (
                <p className={styles.loading}>
                  <Spinner size={12} />
                  Reading the project’s setup…
                </p>
              ) : waiting && approval?.items.every(isSandboxHost) === true ? (
                <p>
                  The project’s settings let sandboxed commands reach these hosts, so dawg keeps
                  them off the list until you approve them. Approving covers exactly what is listed;
                  if any of it changes, dawg asks again.
                </p>
              ) : waiting ? (
                <p>
                  These {words} run commands on your Mac with your permissions, so dawg keeps them
                  off until you approve them. Approving covers exactly what is listed; if any of it
                  changes, dawg asks again.
                </p>
              ) : approval !== null && approval.items.length > 0 ? (
                <p>These {words} may run. dawg asks again if any of them changes.</p>
              ) : (
                <p>The project supplies no hooks or servers that need your consent.</p>
              )}
            </div>
          </Dialog.Description>
          {review.message !== null && (
            <p className={styles.message} role="alert">
              {review.message}
            </p>
          )}
          {review.phase !== "loading" && approval !== null && approval.items.length > 0 && (
            <ul className={styles.items} aria-label={`The ${words}`}>
              {approval.items.map((item) => (
                <ItemRow
                  key={`${item.kind}\n${item.source.path}\n${item.name}`}
                  item={item}
                  homeDir={homeDir}
                />
              ))}
            </ul>
          )}
          <div className={styles.actions}>
            {waiting ? (
              <>
                {/* First, so it has focus when the dialog opens: approving has to be chosen. */}
                <Button disabled={saving} onClick={onDismiss}>
                  Not now
                </Button>
                <Button variant="primary" disabled={saving} onClick={onApprove}>
                  {saving ? (
                    <>
                      <Spinner size={12} />
                      Approving…
                    </>
                  ) : (
                    "Approve"
                  )}
                </Button>
              </>
            ) : (
              <Button onClick={onDismiss}>Close</Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The dialog, connected to the store: shown while a review is open. */
export function TrustDialogContainer() {
  const review = useAppStore((state) => state.trustReview);
  const homeDir = useAppStore((state) => state.homeDir);
  const actions = useActions();
  if (review === null) return null;
  return (
    <TrustDialog
      // Another project's review starts fresh.
      key={review.projectDir}
      review={review}
      homeDir={homeDir}
      onApprove={() => run(actions.answerTrustReview(true))}
      onDismiss={() => run(actions.answerTrustReview(false))}
    />
  );
}
