import { memo, useMemo } from "react";
import styles from "./AnsiText.module.css";
import { type AnsiColor, type AnsiSegment, parseAnsi } from "./ansi.ts";

const FG: Record<AnsiColor, string | undefined> = {
  black: styles.fgBlack,
  red: styles.fgRed,
  green: styles.fgGreen,
  yellow: styles.fgYellow,
  blue: styles.fgBlue,
  magenta: styles.fgMagenta,
  cyan: styles.fgCyan,
  white: styles.fgWhite,
  gray: styles.fgGray,
};

const BG: Record<AnsiColor, string | undefined> = {
  black: styles.bgBlack,
  red: styles.bgRed,
  green: styles.bgGreen,
  yellow: styles.bgYellow,
  blue: styles.bgBlue,
  magenta: styles.bgMagenta,
  cyan: styles.bgCyan,
  white: styles.bgWhite,
  gray: styles.bgGray,
};

function classesOf(segment: AnsiSegment): string | undefined {
  const { style } = segment;
  const names = [
    style.fg && FG[style.fg],
    style.bg && BG[style.bg],
    style.bold && styles.bold,
    style.dim && styles.dim,
    style.italic && styles.italic,
    style.underline && styles.underline,
  ].filter(Boolean);
  return names.length > 0 ? names.join(" ") : undefined;
}

/**
 * Command output with its colours. Text is rendered as React text nodes inside spans, so output
 * that looks like HTML stays text.
 */
export const AnsiText = memo(function AnsiText({ text }: { text: string }) {
  const segments = useMemo(() => parseAnsi(text), [text]);
  return (
    <>
      {segments.map((segment, index) => {
        const className = classesOf(segment);
        // Segments are positional and rebuilt from the whole text, so the index is the identity.
        const key = index;
        return className ? (
          <span key={key} className={className}>
            {segment.text}
          </span>
        ) : (
          <span key={key}>{segment.text}</span>
        );
      })}
    </>
  );
});
