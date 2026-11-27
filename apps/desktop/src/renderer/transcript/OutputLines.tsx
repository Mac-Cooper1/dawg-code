/**
 * Text a tool printed or returned, one element per line, inside a group named for what it is.
 * VoiceOver announces the group ("Output, 24 lines") and steps through it a line at a time,
 * instead of reading the whole block as one run of text.
 *
 * Each line is a block that keeps its newline, so the text looks, selects and copies exactly as
 * the plain text would (blank lines included). A line costs one element, which stays cheap: tool
 * cards draw their bodies only while open, and long transcripts skip off-screen groups.
 */
import { Fragment, memo, type Ref, type UIEvent, useMemo } from "react";
import styles from "./AnsiText.module.css";
import { classesOf } from "./AnsiText.tsx";
import { type AnsiSegment, PLAIN_STYLE, parseAnsi } from "./ansi.ts";
import { plural } from "./toolInfo.ts";

/** Segments split at newlines, without the empty line a final newline leaves. */
export function lineSegments(segments: readonly AnsiSegment[]): AnsiSegment[][] {
  const lines: AnsiSegment[][] = [[]];
  for (const segment of segments) {
    const parts = segment.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part !== "") lines[lines.length - 1]?.push({ text: part, style: segment.style });
    });
  }
  if (lines.length > 1 && lines[lines.length - 1]?.length === 0) lines.pop();
  return lines;
}

export interface OutputLinesProps {
  text: string;
  /** What the block is, for VoiceOver: "Output", "Results", "Input"… The line count is added. */
  label: string;
  /** Read colour codes (command output). Otherwise the text is shown as it is. */
  ansi?: boolean;
  className?: string;
  /** Long blocks scroll inside the card; keyboard users then need to reach them. */
  focusable?: boolean;
  preRef?: Ref<HTMLPreElement>;
  onScroll?: (event: UIEvent<HTMLPreElement>) => void;
}

export const OutputLines = memo(function OutputLines({
  text,
  label,
  ansi = false,
  className,
  focusable = false,
  preRef,
  onScroll,
}: OutputLinesProps) {
  const lines = useMemo(
    () => lineSegments(ansi ? parseAnsi(text) : [{ text, style: PLAIN_STYLE }]),
    [text, ansi],
  );
  // A final newline stays in the text (for copying) without making an empty last line.
  const finalNewline = text.endsWith("\n");
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls; this is text
    <pre
      ref={preRef}
      className={className}
      role="group"
      aria-label={`${label}, ${plural(lines.length, "line")}`}
      onScroll={onScroll}
      // The block scrolls; keyboard users need to reach it.
      tabIndex={focusable ? 0 : undefined}
    >
      {lines.map((segments, index) => (
        <span
          // Lines and segments are positional, rebuilt from the whole text: the index is the
          // identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          key={index}
          className={styles.line}
        >
          {segments.map((segment, at) => {
            const names = classesOf(segment);
            return names ? (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: positional, as above
                key={at}
                className={names}
              >
                {segment.text}
              </span>
            ) : (
              <Fragment
                // biome-ignore lint/suspicious/noArrayIndexKey: positional, as above
                key={at}
              >
                {segment.text}
              </Fragment>
            );
          })}
          {index < lines.length - 1 || finalNewline ? "\n" : null}
        </span>
      ))}
    </pre>
  );
});
