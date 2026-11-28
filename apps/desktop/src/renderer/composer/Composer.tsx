import type { CommandInfo, FileMention, PermissionMode } from "@dawg/protocol";
import {
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { FileMatch, FindFilesResult, ModelOption } from "../../shared/bridge.ts";
import type { ComposerView, ImageAttachment } from "../state/types.ts";
import { Icon } from "../ui/index.ts";
import { AttachButton } from "./AttachButton.tsx";
import { Attachments } from "./Attachments.tsx";
import { CommandMenu } from "./CommandMenu.tsx";
import styles from "./Composer.module.css";
import { ContextMeter } from "./ContextMeter.tsx";
import { commandQuery, filterCommands, takesArguments } from "./commands.ts";
import { EffortMenu } from "./EffortMenu.tsx";
import {
  dragHasFiles,
  filesOf,
  ImageRefused,
  isImageType,
  MAX_IMAGES,
  pasteIsFiles,
  prepareImage,
} from "./images.ts";
import { MentionMenu } from "./MentionMenu.tsx";
import { ModelMenu } from "./ModelMenu.tsx";
import { ModeMenu } from "./ModeMenu.tsx";
import { isResourceMatch } from "./mcpResources.ts";
import { activeMention, applyMention, resolveMentions } from "./mentions.ts";
import { imagesNotKeptText, QueueList } from "./QueueList.tsx";
import { useFileSearch } from "./useFileSearch.ts";

/** How long a one-line notice about attaching stays. */
const NOTICE_MS = 8000;
/** Esc twice within this long, with the field empty and nothing running, opens rewind. */
export const REWIND_ESCAPE_MS = 500;

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
  /** Images attached to this session's message. */
  attachments: readonly ImageAttachment[];
  /** Paths the `@` menu inserted into this session's draft. */
  mentionPaths: readonly string[];
  onDraftChange(text: string): void;
  /**
   * Enter or Send, with the files the text mentions when there are any. The store decides
   * whether it answers a card, queues or starts a turn (with the attached images).
   */
  onSubmit(text: string, mentions?: FileMention[]): void;
  /** `@`: files and folders under the session's folder that match. Rejects with the reason. */
  onFindFiles(query: string): Promise<FindFilesResult>;
  onAddAttachments(images: ImageAttachment[]): void;
  onRemoveAttachment(id: string): void;
  /** The `@` menu inserted this path. */
  onRememberMention(relativePath: string): void;
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
  /** Esc twice with the field empty while nothing runs: the rewind dialog. */
  onRewind?(): void;
}

/** A value that belongs to one session: it reads as `initial` in any other. */
function useSessionValue<T>(scope: string, initial: T) {
  const [state, setState] = useState<{ scope: string; value: T }>({ scope, value: initial });
  const value = state.scope === scope ? state.value : initial;
  const set = useCallback((next: T) => setState({ scope, value: next }), [scope]);
  return [value, set] as const;
}

function newImageId(): string {
  return `image-${crypto.randomUUID()}`;
}

/**
 * The composer: queued messages, the message box with its slash-command and `@` file menus and
 * attached images, and the bar of pickers (mode, model, effort), the context meter and
 * Send / Stop.
 */
export function Composer(props: ComposerProps) {
  const { view } = props;
  const sessionId = view.sessionId;
  const commandListId = useId();
  const mentionListId = useId();
  const optionPrefix = useId();
  // IME composition (Japanese, Chinese…): Enter confirms the composition, it must not send.
  const composing = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [active, setActive] = useState(0);
  // The draft at the moment Esc closed the command menu; the menu stays closed until it changes.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  // A new draft (another session) puts the caret at its end, as the browser does.
  const [caret, setCaret] = useSessionValue(sessionId, view.draft.length);
  /** Where the caret goes once a draft written here is on screen. */
  const pendingCaret = useRef<number | null>(null);
  // The `@` token Esc closed (its start); it stays closed until that token is gone.
  const [dismissedMention, setDismissedMention] = useSessionValue<number | null>(sessionId, null);
  /** Paths the `@` menu showed, per session: typed out in full, they count as mentions too. */
  const found = useRef(new Map<string, Set<string>>());
  /** When Esc was last pressed with the field empty and nothing running (for Esc twice). */
  const lastEscape = useRef<number | null>(null);
  /** Images being prepared, per session (the work goes on if the person switches away). */
  const preparingRef = useRef<Record<string, number>>({});
  const [preparingCounts, setPreparingCounts] = useState<Record<string, number>>({});
  const preparing = preparingCounts[sessionId] ?? 0;
  const [notice, setNotice] = useState<{ scope: string; text: string } | null>(null);
  const shownNotice = notice?.scope === sessionId ? notice.text : null;
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const query = commandQuery(view.draft);
  const commands = query === null ? [] : filterCommands(view.commands, query);
  const commandOpen = commands.length > 0 && dismissedFor !== view.draft && !props.disabled;

  const mention =
    !commandOpen && focused && !props.disabled
      ? activeMention(view.draft, Math.min(caret, view.draft.length))
      : null;
  const mentionOpen = mention !== null && dismissedMention !== mention.start;
  const search = useFileSearch(mentionOpen ? mention.query : null, props.onFindFiles, sessionId);

  const optionCount = commandOpen ? commands.length : mentionOpen ? search.matches.length : 0;
  const activeIndex = Math.max(0, Math.min(active, optionCount - 1));
  const optionId = (index: number) => `${optionPrefix}-option-${index}`;
  const listOpen = commandOpen || mentionOpen;
  const listId = commandOpen ? commandListId : mentionListId;

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the new draft is on screen
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null || !textarea.current) return;
    pendingCaret.current = null;
    textarea.current.setSelectionRange(at, at);
  }, [view.draft]);

  // Once its token is gone, a mention closed with Esc may open again for the next one.
  const mentionStart = mention?.start ?? null;
  useEffect(() => {
    if (mentionStart === null && dismissedMention !== null) setDismissedMention(null);
  }, [mentionStart, dismissedMention, setDismissedMention]);

  // A new answer keeps the highlighted path where it is still listed, else starts at the best.
  const shownMatches = useRef(search.matches);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for each new answer
  useLayoutEffect(() => {
    const previous = shownMatches.current;
    shownMatches.current = search.matches;
    if (previous === search.matches) return;
    const path = previous[activeIndex]?.relativePath;
    const index = search.matches.findIndex((match) => match.relativePath === path);
    setActive(Math.max(0, index));
  }, [search.matches]);

  // Remember every path the menu showed, for reading mentions typed out in full.
  useEffect(() => {
    if (search.matches.length === 0) return;
    let paths = found.current.get(sessionId);
    if (!paths) {
      paths = new Set();
      found.current.set(sessionId, paths);
    }
    for (const match of search.matches) paths.add(match.relativePath);
  }, [search.matches, sessionId]);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  /** Enter or Send. With nothing to send (or no engine yet), sends nothing. */
  const send = () => {
    if (!props.canSend || props.disabled || preparing > 0) return false;
    const text = view.draft;
    if (text.trim() === "" && props.attachments.length === 0) return false;
    const known = new Set([...props.mentionPaths, ...(found.current.get(sessionId) ?? [])]);
    const mentions = resolveMentions(text, (path) => known.has(path));
    if (mentions.length > 0) props.onSubmit(text, mentions);
    else props.onSubmit(text);
    setNotice(null);
    return true;
  };

  const changeDraft = (text: string) => {
    setActive(0);
    if (!text.startsWith("/")) setDismissedFor(null);
    props.onDraftChange(text);
  };

  const chooseCommand = (command: CommandInfo, how: "enter" | "tab" | "click") => {
    if (!takesArguments(command) && how !== "tab") {
      if (props.canSend) props.onSubmit(`/${command.name}`);
      return;
    }
    changeDraft(takesArguments(command) ? `/${command.name} ` : `/${command.name}`);
  };

  /** Writes the chosen path over the `@` token; Tab on a folder keeps searching inside it. */
  const chooseMention = (match: FileMatch, how: "enter" | "tab" | "click") => {
    if (!mention) return;
    const browse = how === "tab" && match.kind === "directory";
    const next = applyMention(view.draft, mention, match.relativePath, { browse });
    // A resource is read by the engine from its `@server:uri` text, not sent as a file mention.
    if (!browse && !isResourceMatch(match)) props.onRememberMention(match.relativePath);
    pendingCaret.current = next.caret;
    setCaret(next.caret);
    changeDraft(next.text);
  };

  /** Pasted, dropped or picked files: the images among them are prepared and attached. */
  const attachFiles = (files: readonly File[]) => {
    if (files.length === 0 || props.disabled) return;
    // Bound to this session, even if the person switches away while images are prepared.
    const scope = sessionId;
    const add = props.onAddAttachments;
    const say = (text: string) => setNotice({ scope, text });
    if (!view.canAttachImages) {
      say(`${view.model.label} can't view images, so nothing was attached.`);
      return;
    }
    const images = files.filter((file) => isImageType(file.type));
    let problem: string | null = null;
    const other = files.find((file) => !isImageType(file.type));
    if (other) {
      problem =
        files.length === 1
          ? `${other.name || "That file"} was not attached: only PNG, JPEG, GIF and WebP images can be.`
          : "Only PNG, JPEG, GIF and WebP images can be attached.";
    }
    const busy = preparingRef.current[scope] ?? 0;
    const room = Math.max(0, MAX_IMAGES - props.attachments.length - busy);
    const taken = images.slice(0, room);
    if (taken.length < images.length) problem = `A message can have up to ${MAX_IMAGES} images.`;
    if (problem) say(problem);
    else setNotice(null);
    if (taken.length === 0) return;

    const count = (delta: number) => {
      const next = Math.max(0, (preparingRef.current[scope] ?? 0) + delta);
      preparingRef.current = { ...preparingRef.current, [scope]: next };
      setPreparingCounts(preparingRef.current);
    };
    count(taken.length);
    void (async () => {
      for (const file of taken) {
        try {
          add([await prepareImage(file, newImageId())]);
        } catch (error) {
          say(error instanceof ImageRefused ? error.message : `${file.name} was not attached.`);
        } finally {
          count(-1);
        }
      }
    })();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing) return;
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey;

    if (listOpen) {
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && optionCount > 0) {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((activeIndex + step + optionCount) % optionCount);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && plain) {
        const how = event.key === "Tab" ? "tab" : "enter";
        const command = commandOpen ? commands[activeIndex] : undefined;
        const match = mentionOpen ? search.matches[activeIndex] : undefined;
        if (command) {
          event.preventDefault();
          chooseCommand(command, how);
          return;
        }
        if (match) {
          event.preventDefault();
          chooseMention(match, how);
          return;
        }
      }
      if (event.key === "Escape") {
        // Closing the menu is all Esc does here; it must not also interrupt dawg.
        event.preventDefault();
        event.stopPropagation();
        if (commandOpen) setDismissedFor(view.draft);
        else if (mention) setDismissedMention(mention.start);
        return;
      }
    }

    if (event.key === "Escape" && plain && !event.shiftKey) {
      // Esc twice, with the field empty and nothing running, opens rewind (as in Claude Code).
      const idle = view.status === "idle" || view.status === "error";
      if (idle && view.draft.trim() === "" && props.onRewind) {
        const now = Date.now();
        if (lastEscape.current !== null && now - lastEscape.current <= REWIND_ESCAPE_MS) {
          lastEscape.current = null;
          event.preventDefault();
          props.onRewind();
          return;
        }
        lastEscape.current = now;
      } else {
        lastEscape.current = null;
      }
    } else {
      lastEscape.current = null;
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

  const takesDrop = (event: DragEvent) => dragHasFiles(event.dataTransfer);
  const dropHint = view.canAttachImages
    ? "Drop images to attach them"
    : `${view.model.label} can't view images`;
  const full = props.attachments.length + preparing >= MAX_IMAGES;

  return (
    // A landmark, so VoiceOver's rotor reaches the message box directly.
    <section className={styles.composer} aria-label="Composer">
      <div className={styles.inner}>
        <QueueList
          queue={view.queue}
          onSendNow={props.onSendQueuedNow}
          onRemove={props.onRemoveQueued}
        />
        {view.draftImagesNotKept > 0 && (
          <p className={styles.notKept}>{imagesNotKeptText(view.draftImagesNotKept, "draft")}</p>
        )}
        {commandOpen && (
          <CommandMenu
            id={commandListId}
            commands={commands}
            active={activeIndex}
            optionId={optionId}
            onChoose={(command) => chooseCommand(command, "click")}
            onHover={setActive}
          />
        )}
        {mentionOpen && (
          <MentionMenu
            id={mentionListId}
            search={search}
            active={activeIndex}
            optionId={optionId}
            onChoose={(match) => chooseMention(match, "click")}
            onHover={setActive}
          />
        )}
        {shownNotice !== null && (
          <div className={styles.attachNotice} role="status">
            <Icon name="alert" size={14} />
            <span className={styles.attachNoticeText}>{shownNotice}</span>
            <button
              type="button"
              className={styles.attachNoticeClose}
              aria-label="Dismiss"
              onClick={() => setNotice(null)}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
        {/* Dropping files is a pointer shortcut; the attach button and paste work from the keyboard. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
        <div
          className={styles.box}
          data-disabled={props.disabled ? "true" : undefined}
          data-dropping={dragging ? (view.canAttachImages ? "yes" : "no") : undefined}
          onDragEnter={(event) => {
            if (!takesDrop(event)) return;
            event.preventDefault();
            dragDepth.current++;
            setDragging(true);
          }}
          onDragOver={(event) => {
            if (!takesDrop(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect =
              view.canAttachImages && !props.disabled ? "copy" : "none";
          }}
          onDragLeave={(event) => {
            if (!takesDrop(event)) return;
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          }}
          onDrop={(event) => {
            if (!takesDrop(event)) return;
            event.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            attachFiles(filesOf(event.dataTransfer));
          }}
        >
          {dragging && (
            <div className={styles.dropHint} aria-hidden="true">
              <Icon name="image" />
              {dropHint}
            </div>
          )}
          <Attachments
            images={props.attachments}
            preparing={preparing}
            disabled={props.disabled}
            onRemove={(id) => {
              props.onRemoveAttachment(id);
              textarea.current?.focus();
            }}
          />
          {/*
            The textarea drives whichever menu is open, which owns no focus: it says a list pops
            up, which one, and which option is active. (It keeps the textbox role: a combobox
            role would make VoiceOver call a multi-line message box a combo box.)
          */}
          <textarea
            ref={textarea}
            className={styles.textarea}
            rows={2}
            value={view.draft}
            placeholder={view.placeholder}
            aria-label="Message to dawg"
            aria-haspopup="listbox"
            aria-autocomplete="list"
            aria-controls={listOpen ? listId : undefined}
            aria-activedescendant={listOpen && optionCount > 0 ? optionId(activeIndex) : undefined}
            disabled={props.disabled}
            spellCheck
            onChange={(event) => {
              setCaret(event.target.selectionStart ?? event.target.value.length);
              changeDraft(event.target.value);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              if (!pasteIsFiles(event.clipboardData)) return;
              event.preventDefault();
              attachFiles(filesOf(event.clipboardData));
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
          />
          <div className={styles.bar}>
            <AttachButton
              canAttach={view.canAttachImages}
              modelLabel={view.model.label}
              full={full}
              disabled={props.disabled}
              onFiles={attachFiles}
            />
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
    </section>
  );
}
