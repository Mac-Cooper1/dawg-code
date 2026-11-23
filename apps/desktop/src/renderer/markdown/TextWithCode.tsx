import type { ReactNode } from "react";
import styles from "./Markdown.module.css";

/**
 * Short plain text (a message, a card's reason, an option's description) with its `backtick`
 * spans shown as inline code, styled like Markdown's. Nothing else is interpreted: the rest stays
 * text, and full Markdown is reserved for replies, plans and command output.
 */
export function withInlineCode(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /`([^`\n]+)`/g;
  let last = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <code key={match.index} className={styles.inlineCode}>
        {match[1]}
      </code>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** `withInlineCode` as a component. */
export function TextWithCode({ text }: { text: string }) {
  return <>{withInlineCode(text)}</>;
}
