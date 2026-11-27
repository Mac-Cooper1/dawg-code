/**
 * A tool call in the transcript: a one-line header (what it did, to what, how it went) that opens
 * to the details: a command's coloured output, a file's lines, an edit's diff, search results, or
 * the input and result of any other tool.
 */
import type { ContentPart } from "@dawg/protocol";
import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { displayPath, formatDuration } from "../lib/format.ts";
import { toolTarget, toolVerb } from "../lib/tools.ts";
import type { ToolCallItem } from "../state/types.ts";
import { Icon, Spinner } from "../ui/index.ts";
import { DiffView } from "./DiffView.tsx";
import type { TranscriptEnv } from "./env.ts";
import { FileLinesView } from "./FileLinesView.tsx";
import { useNow } from "./hooks.ts";
import { OutputLines } from "./OutputLines.tsx";
import styles from "./ToolCard.module.css";
import {
  commandOutput,
  contentText,
  EDIT_TOOLS,
  type MetaPart,
  parseReadResult,
  toolDurationMs,
  toolIcon,
  toolMeta,
} from "./toolInfo.ts";

/** Lines of a Read result shown before "Show all". */
export const READ_PREVIEW_LINES = 15;

/** Output kept on screen; earlier output of a very long run is dropped from the top. */
const LIVE_OUTPUT_CHARS = 200_000;

function stringInput(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function MetaView({ part }: { part: MetaPart }) {
  if (part.kind === "diff") {
    return (
      <span className={styles.meta}>
        <span className={styles.add}>+{part.additions}</span>{" "}
        <span className={styles.del}>−{part.deletions}</span>
      </span>
    );
  }
  const tone = part.tone === "ok" ? styles.ok : part.tone === "bad" ? styles.bad : undefined;
  return <span className={tone ? `${styles.meta} ${tone}` : styles.meta}>{part.text}</span>;
}

function Images({ content }: { content: readonly ContentPart[] | null }) {
  const images = (content ?? []).filter(
    (part): part is Extract<ContentPart, { type: "image" }> =>
      part.type === "image" && part.mediaType.startsWith("image/"),
  );
  if (images.length === 0) return null;
  return (
    <div className={styles.images}>
      {images.map((image, index) => (
        <img
          // biome-ignore lint/suspicious/noArrayIndexKey: a result's parts never reorder
          key={index}
          className={styles.thumb}
          src={`data:${image.mediaType};base64,${image.data}`}
          alt={`Tool result ${index + 1}`}
        />
      ))}
    </div>
  );
}

/** The result text of a call that failed, was refused or was stopped. */
function ProblemText({ item }: { item: ToolCallItem }) {
  const text = contentText(item.content).trim();
  const fallback =
    item.state === "interrupted"
      ? "Stopped before it finished."
      : item.state === "denied"
        ? "Not allowed."
        : "No details.";
  const isError = item.state === "error" || item.state === "invalid";
  return (
    <OutputLines
      text={text || fallback}
      label={isError ? "Error" : "Result"}
      className={`${styles.output} ${isError ? styles.errorText : styles.wrap}`}
    />
  );
}

function Running({ item }: { item: ToolCallItem }) {
  return <div className={styles.placeholder}>{item.statusLine ?? "Running…"}</div>;
}

/** Keeps a scroll box pinned to its bottom while text is added, unless the person scrolled up. */
function useStickToBottom(active: boolean, content: string) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the text grows
  useLayoutEffect(() => {
    const box = ref.current;
    if (box && active && stick.current) box.scrollTop = box.scrollHeight;
  }, [active, content]);
  const onScroll = () => {
    const box = ref.current;
    if (box) stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 8;
  };
  return { ref, onScroll };
}

function BashBody({ item, env }: { item: ToolCallItem; env: TranscriptEnv }) {
  const running = item.state === "running";
  const finished = useMemo(() => (running ? null : commandOutput(item)), [running, item]);
  let text = finished ? finished.output : item.output.map((chunk) => chunk.text).join("");
  if (text.length > LIVE_OUTPUT_CHARS) text = text.slice(-LIVE_OUTPUT_CHARS);
  const { ref, onScroll } = useStickToBottom(running, text);
  const display = item.display?.kind === "command" ? item.display : null;
  const otherCwd = display !== null && display.cwd !== env.cwd ? display.cwd : null;
  return (
    <>
      {text === "" ? (
        <div className={styles.placeholder}>{running ? "Waiting for output…" : "No output."}</div>
      ) : (
        <OutputLines
          text={text}
          label="Output"
          ansi
          focusable
          className={styles.output}
          preRef={ref}
          onScroll={onScroll}
        />
      )}
      {running && item.statusLine && <div className={styles.status}>{item.statusLine}</div>}
      {finished && finished.notes.length > 0 && (
        <div className={styles.notes}>
          {finished.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      )}
      {(otherCwd !== null || display?.outputPath) && (
        <div className={styles.footer}>
          {otherCwd !== null && (
            <span>
              Ran in{" "}
              <span className={styles.footerPath}>
                {displayPath(otherCwd, env.cwd, env.homeDir)}
              </span>
            </span>
          )}
          {display?.outputPath && (
            <span>
              Full output in{" "}
              <span className={styles.footerPath}>
                {displayPath(display.outputPath, env.cwd, env.homeDir)}
              </span>
            </span>
          )}
        </div>
      )}
    </>
  );
}

function ReadBody({ item }: { item: ToolCallItem }) {
  const [showAll, setShowAll] = useState(false);
  const display = item.display?.kind === "file" ? item.display : null;
  const file = useMemo(
    () => parseReadResult(contentText(item.content), display),
    [item.content, display],
  );
  if (item.state === "running") return <Running item={item} />;
  if (item.state !== "success") return <ProblemText item={item} />;
  if (item.content?.some((part) => part.type === "image")) return <Images content={item.content} />;
  if (file.lines.length === 0) {
    return <div className={styles.placeholder}>{file.notes || "The file is empty."}</div>;
  }
  const count = showAll ? file.lines.length : Math.min(file.lines.length, READ_PREVIEW_LINES);
  const first = file.start;
  const lastShown = first + count - 1;
  const of = display?.totalLines ?? first + file.lines.length - 1;
  return (
    <>
      <FileLinesView file={file} count={count} />
      <div className={styles.footer}>
        <span>
          Showing lines {first}–{lastShown} of {of.toLocaleString("en-US")}
        </span>
        {file.lines.length > count && (
          <button type="button" className={styles.link} onClick={() => setShowAll(true)}>
            Show all
          </button>
        )}
      </div>
    </>
  );
}

function EditBody({ item, env }: { item: ToolCallItem; env: TranscriptEnv }) {
  const display = item.display?.kind === "diff" ? item.display : null;
  if (item.state === "running") return <Running item={item} />;
  if (display === null) return <ProblemText item={item} />;
  const openInChanges = env.openInChanges;
  return (
    <>
      {display.hunks.length === 0 ? (
        <div className={styles.placeholder}>No changes to the file.</div>
      ) : (
        <DiffView hunks={display.hunks} />
      )}
      {openInChanges && (
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.link}
            onClick={() => openInChanges(display.filePath)}
          >
            Open in Changes
          </button>
        </div>
      )}
    </>
  );
}

function TextResultBody({ item }: { item: ToolCallItem }) {
  if (item.state === "running") return <Running item={item} />;
  if (item.state !== "success") return <ProblemText item={item} />;
  const text = contentText(item.content);
  return (
    <OutputLines text={text || "No results."} label="Results" focusable className={styles.output} />
  );
}

function GenericBody({ item }: { item: ToolCallItem }) {
  const input = useMemo(() => JSON.stringify(item.input, null, 2), [item.input]);
  const result = contentText(item.content);
  return (
    <>
      <div className={styles.section}>Input</div>
      <OutputLines text={input} label="Input" className={`${styles.output} ${styles.wrap}`} />
      {item.state === "running" ? (
        <Running item={item} />
      ) : item.state !== "success" ? (
        <>
          <div className={styles.section}>Result</div>
          <ProblemText item={item} />
        </>
      ) : (
        <>
          <div className={styles.section}>Result</div>
          {result !== "" && (
            <OutputLines
              text={result}
              label="Result"
              className={`${styles.output} ${styles.wrap}`}
            />
          )}
          <Images content={item.content} />
          {result === "" && !item.content?.length && (
            <div className={styles.placeholder}>No result.</div>
          )}
        </>
      )}
    </>
  );
}

function ToolBody({ item, env }: { item: ToolCallItem; env: TranscriptEnv }) {
  if (item.toolName === "Bash") return <BashBody item={item} env={env} />;
  if (item.toolName === "Read") return <ReadBody item={item} />;
  if (EDIT_TOOLS.has(item.toolName)) return <EditBody item={item} env={env} />;
  if (item.toolName === "Grep" || item.toolName === "Glob") return <TextResultBody item={item} />;
  return <GenericBody item={item} />;
}

export interface ToolCardProps {
  item: ToolCallItem;
  open: boolean;
  env: TranscriptEnv;
}

export const ToolCard = memo(function ToolCard({ item, open, env }: ToolCardProps) {
  const running = item.state === "running";
  const now = useNow(running);
  const bodyId = useId();
  const verb = toolVerb(item.toolName, item.state, item.display);
  const target =
    toolTarget(item.toolName, item.input, env.cwd, env.homeDir) ||
    (stringInput(item.input, "description") ?? "");
  const meta = toolMeta(item);
  const isCommand = item.toolName === "Bash" || item.display?.kind === "command";
  const duration = isCommand && !running ? toolDurationMs(item) : null;
  const time = running
    ? formatDuration(Math.max(0, now - item.startedAt))
    : duration !== null
      ? formatDuration(duration)
      : null;
  // The header's parts are separate spans; spell the name out so VoiceOver reads it with pauses.
  const name = [
    `${verb} ${target}`.trim(),
    ...meta.map((part) =>
      part.kind === "diff" ? `+${part.additions} −${part.deletions}` : part.text,
    ),
    time,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div className={styles.card} data-state={item.state} data-open={open ? "true" : "false"}>
      <button
        type="button"
        className={styles.header}
        aria-label={name}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => env.setItemOpen(item.id, !open)}
      >
        {running ? (
          <span className={styles.spinnerBox}>
            <Spinner size={12} />
          </span>
        ) : (
          <Icon name={toolIcon(item.toolName)} className={styles.icon} />
        )}
        <span className={styles.verb}>{verb}</span>
        <span className={styles.target} title={target}>
          {target}
        </span>
        {meta.map((part, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: meta parts are positional
          <MetaView key={index} part={part} />
        ))}
        {time !== null && <span className={styles.meta}>{time}</span>}
        <Icon
          name="chevron-right"
          size={14}
          className={open ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron}
        />
      </button>
      {open && (
        <div id={bodyId} className={styles.body}>
          <ToolBody item={item} env={env} />
        </div>
      )}
    </div>
  );
});
