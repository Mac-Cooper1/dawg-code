import { AlertDialog } from "radix-ui";
import type { ReactNode } from "react";
import { Button } from "./Button.tsx";
import styles from "./ui.module.css";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** A question: "Delete “Fix the split”?" */
  title: string;
  /** What will happen, in a sentence or two. */
  children: ReactNode;
  confirmLabel: string;
  /** Fills the confirm button red, for an action that cannot be undone. */
  destructive?: boolean;
  onConfirm(): void;
  /** Where focus goes once the dialog has closed. Default: back to what had it before. */
  onCloseAutoFocus?(event: Event): void;
}

/**
 * Asks before an action that cannot be undone. Cancel has focus when it opens, so Enter and Esc
 * both leave things as they are; the confirm button has to be chosen.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={styles.dialogOverlay} />
        <AlertDialog.Content
          className={styles.dialog}
          {...(props.onCloseAutoFocus ? { onCloseAutoFocus: props.onCloseAutoFocus } : {})}
        >
          <AlertDialog.Title className={styles.dialogTitle}>{props.title}</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className={styles.dialogText}>{props.children}</div>
          </AlertDialog.Description>
          <div className={styles.dialogActions}>
            <AlertDialog.Cancel asChild>
              <Button>Cancel</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                variant={props.destructive ? "destructive" : "primary"}
                onClick={props.onConfirm}
              >
                {props.confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
