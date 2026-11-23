import { memo, useEffect, useMemo, useState } from "react";
import { Icon } from "../ui/index.ts";
import styles from "./CodeBlock.module.css";
import { highlightCode, normalizeLanguage } from "./highlight.ts";

/** Copies text to the clipboard and says "Copied" for a moment. */
export function CopyButton({ text, label = "Copy code" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // The clipboard refused (no permission or no focus): nothing was copied, so say nothing.
    }
  }

  return (
    <button
      type="button"
      className={styles.copy}
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      data-copied={copied ? "true" : undefined}
    >
      <Icon name={copied ? "check" : "copy"} size={12} />
      <span aria-hidden="true">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

export interface CodeBlockProps {
  code: string;
  /** From the fence's info string ("ts", "python"); null for none. */
  language: string | null;
}

/**
 * A fenced code block: a header with the language and a Copy button, then the code, highlighted
 * when the language is known. Memoised on its text, so blocks above a streaming paragraph do not
 * re-render (or re-highlight) while it grows.
 */
export const CodeBlock = memo(function CodeBlock({ code, language }: CodeBlockProps) {
  const highlighted = useMemo(() => highlightCode(code, language), [code, language]);
  const name = normalizeLanguage(language);
  return (
    <div className={styles.block}>
      <div className={styles.header}>
        <span className={styles.language}>{name ?? "text"}</span>
        <CopyButton text={code} />
      </div>
      <pre className={styles.pre} data-language={name ?? undefined}>
        <code>{highlighted ?? code}</code>
      </pre>
    </div>
  );
});
