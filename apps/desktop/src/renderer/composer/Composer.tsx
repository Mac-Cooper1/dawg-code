import type { CommandInfo, PermissionMode } from "@dawg/protocol";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import type { ModelOption } from "../../shared/bridge.ts";
import type { ComposerView } from "../state/types.ts";
import { Icon } from "../ui/index.ts";
import { AttachButton } from "./AttachButton.tsx";
import { CommandMenu } from "./CommandMenu.tsx";
import styles from "./Composer.module.css";
import { ContextMeter } from "./ContextMeter.tsx";
import { commandQuery, filterCommands, takesArguments } from "./commands.ts";
import { EffortMenu } from "./EffortMenu.tsx";
import { ModelMenu } from "./ModelMenu.tsx";
import { ModeMenu } from "./ModeMenu.tsx";
import { QueueList } from "./QueueList.tsx";

export interface ComposerProps {
  view: ComposerView;
  /** Every model the person can pick (`state.models`). */
  models: readonly ModelOption[];
  /** The model loaded in the bundled runtime, so the picker can say switching reloads it. */
  loadedModelId?: string | null;
  /** False while the engine is not ready: Enter and Send do nothing. */
  canSend: boolean;
  /** The engine connection failed for good: the whole composer is disabled. */
  disabled?: boolean;
  onDraftChange(text: string): void;
  /** Enter or Send. The store decides whether it answers a card, queues or starts a turn. */
  onSubmit(text: string): void;
  /** Stop, or Esc while dawg works. */
  onInterrupt(): void;
  onSetMode(mode: PermissionMode): void;
  /** Shift+Tab in the textarea. */
  onCycleMode(): void;
  onSetModel(id: string): void;
  onSetEffort(effort: string | null): void;
  onCompact(): void;
  onSendQueuedNow(id: string): void;
  onRemoveQueued(id: string): void;
  /** "Manage models…": Settings → Models. */
  onManageModels(): void;
}

/**
 * The composer: queued messages, the message box with its slash-command menu, and the bar of
 * pickers (mode, model, effort), the context meter and Send / Stop.
 */
export function Composer(props: ComposerProps) {
  const { view } = props;
  const listId = useId();
  const optionPrefix = useId();
  // IME composition (Japanese, Chinese…): Enter confirms the composition, it must not send.
  const composing = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [active, setActive] = useState(0);
  // The draft at the moment Esc closed the command menu; the menu stays closed until it changes.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  const query = commandQuery(view.draft);
  const matches = query === null ? [] : filterCommands(view.commands, query);
  const menuOpen = matches.length > 0 && dismissedFor !== view.draft && !props.disabled;
  const activeIndex = Math.min(active, matches.length - 1);
  const optionId = (index: number) => `${optionPrefix}-option-${index}`;

  /** Enter or Send. With nothing to send (or no engine yet), sends nothing. */
  const send = () => {
    if (!props.canSend || props.disabled || view.draft.trim() === "") return false;
    props.onSubmit(view.draft);
    return true;
  };

  const changeDraft = (text: string) => {
    setActive(0);
    if (!text.startsWith("/")) setDismissedFor(null);
    props.onDraftChange(text);
  };

  const choose = (command: CommandInfo, how: "enter" | "tab" | "click") => {
    if (!takesArguments(command) && how !== "tab") {
      if (props.canSend) props.onSubmit(`/${command.name}`);
      return;
    }
    changeDraft(takesArguments(command) ? `/${command.name} ` : `/${command.name}`);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing) return;
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey;

    if (menuOpen) {
      const chosen = matches[activeIndex];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((activeIndex + step + matches.length) % matches.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && plain && chosen) {
        event.preventDefault();
        choose(chosen, event.key === "Tab" ? "tab" : "enter");
        return;
      }
      if (event.key === "Escape") {
        // Closing the menu is all Esc does here; it must not also interrupt dawg.
        event.preventDefault();
        event.stopPropagation();
        setDismissedFor(view.draft);
        return;
      }
    }

    if (event.key === "Tab" && event.shiftKey && plain) {
      event.preventDefault();
      props.onCycleMode();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className={styles.composer}>
      <div className={styles.inner}>
        <QueueList
          queue={view.queue}
          onSendNow={props.onSendQueuedNow}
          onRemove={props.onRemoveQueued}
        />
        {menuOpen && (
          <CommandMenu
            id={listId}
            commands={matches}
            active={activeIndex}
            optionId={optionId}
            onChoose={(command) => choose(command, "click")}
          />
        )}
        <div className={styles.box} data-disabled={props.disabled ? "true" : undefined}>
          <textarea
            ref={textarea}
            className={styles.textarea}
            rows={2}
            value={view.draft}
            placeholder={view.placeholder}
            aria-label="Message to dawg"
            aria-autocomplete="list"
            aria-controls={menuOpen ? listId : undefined}
            aria-activedescendant={menuOpen ? optionId(activeIndex) : undefined}
            disabled={props.disabled}
            spellCheck
            onChange={(event) => changeDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
          />
          <div className={styles.bar}>
            <AttachButton />
            <ModeMenu mode={view.mode} disabled={props.disabled} onSetMode={props.onSetMode} />
            <span className={styles.separator} aria-hidden="true" />
            <ModelMenu
              current={view.model}
              models={props.models}
              loadedModelId={props.loadedModelId ?? null}
              disabled={props.disabled}
              onSetModel={props.onSetModel}
              onManageModels={props.onManageModels}
            />
            <EffortMenu
              effort={view.effort}
              modelLabel={view.model.label}
              disabled={props.disabled}
              onSetEffort={props.onSetEffort}
            />
            <span className={styles.grow} />
            {view.context && (
              <ContextMeter
                context={view.context}
                disabled={props.disabled}
                onCompact={props.onCompact}
              />
            )}
            {view.working ? (
              <button
                type="button"
                className={`${styles.send} ${styles.stop}`}
                aria-label="Stop, or press Esc"
                aria-keyshortcuts="Escape"
                onClick={props.onInterrupt}
              >
                <Icon name="stop" size={14} />
              </button>
            ) : (
              // Always drawn in the accent, as approved; only a failed connection disables it.
              // A click with nothing to send puts the person in the message box instead.
              <button
                type="button"
                className={styles.send}
                aria-label="Send"
                aria-keyshortcuts="Enter"
                disabled={props.disabled}
                onClick={() => {
                  if (!send()) textarea.current?.focus();
                }}
              >
                <Icon name="send" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
