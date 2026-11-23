/**
 * Markdown from the model (replies, plans, command output): GitHub-flavoured (tables, task lists,
 * strikethrough), with highlighted code blocks and links that ask before they open.
 *
 * Raw HTML is never rendered: react-markdown turns it into plain text unless a rehype-raw plugin
 * is added, and none is. While a reply streams, its text goes through `prepareStreamingMarkdown`
 * so half-written markup renders as it will when finished.
 */
import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock.tsx";
import { rehypeCaret } from "./caret.ts";
import type { HastRoot } from "./highlight.ts";
import styles from "./Markdown.module.css";
import { useReducedMotion } from "./motion.ts";
import { OpenLinkContext, SafeLink } from "./SafeLink.tsx";
import { prepareStreamingMarkdown } from "./streaming.ts";

type HastNode = HastRoot["children"][number];

function textOf(node: HastNode | undefined): string {
  if (node === undefined) return "";
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map((child) => textOf(child)).join("");
  return "";
}

/** The code and language of a `<pre><code class="language-x">` block. */
function codeOfPre(pre: HastNode | undefined): { code: string; language: string | null } {
  const code = pre?.type === "element" ? pre.children.find((c) => c.type === "element") : undefined;
  if (code === undefined || code.type !== "element") return { code: textOf(pre), language: null };
  const classes = code.properties.className;
  const list = Array.isArray(classes) ? classes.map(String) : [];
  const language = list.find((name) => name.startsWith("language-"))?.slice("language-".length);
  // The parser keeps the newline before the closing fence; the block does not show it.
  return { code: textOf(code).replace(/\n$/, ""), language: language ?? null };
}

/** Module constants, so react-markdown keeps the same component types between renders. */
const COMPONENTS: Components = {
  a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
  // Remote images are not fetched; they show as a link to the image instead.
  img: ({ src, alt }) => (
    <SafeLink href={typeof src === "string" ? src : undefined}>
      {alt ? `Image: ${alt}` : "Image"}
    </SafeLink>
  ),
  pre: ({ node }) => {
    const { code, language } = codeOfPre(node as HastNode | undefined);
    return <CodeBlock code={code} language={language} />;
  },
  code: ({ children }) => <code className={styles.inlineCode}>{children}</code>,
  table: ({ children }) => (
    <div className={styles.tableScroll}>
      <table>{children}</table>
    </div>
  ),
};

const REMARK_PLUGINS = [remarkGfm];
const CARET_PLUGINS = [rehypeCaret(styles.caret)];

export interface MarkdownProps {
  text: string;
  /** The text is still arriving: render partial markup stably and show the caret. */
  streaming?: boolean;
  /** Called with the full URL after the person confirms opening a link. */
  onOpenLink(url: string): void;
  className?: string;
}

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  onOpenLink,
  className,
}: MarkdownProps) {
  const reducedMotion = useReducedMotion();
  const source = useMemo(
    () => (streaming ? prepareStreamingMarkdown(text) : text),
    [text, streaming],
  );
  const caret = streaming && !reducedMotion;
  return (
    <OpenLinkContext.Provider value={onOpenLink}>
      <div
        className={className ? `${styles.markdown} ${className}` : styles.markdown}
        data-streaming={streaming ? "true" : undefined}
      >
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={caret ? CARET_PLUGINS : undefined}
          components={COMPONENTS}
        >
          {source}
        </ReactMarkdown>
      </div>
    </OpenLinkContext.Provider>
  );
});
