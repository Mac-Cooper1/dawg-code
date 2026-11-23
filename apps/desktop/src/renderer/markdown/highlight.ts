/**
 * Syntax highlighting for code blocks: refractor (Prism grammars) turns code into a hast tree,
 * whose token classes are mapped to this module's CSS classes and rendered to React elements
 * through hast-util-to-jsx-runtime. Only a sensible set of languages is registered, to keep the
 * renderer bundle small.
 *
 * Results are cached by language and code, so a streaming message does not highlight its earlier,
 * unchanged code blocks again on every delta, and switching sessions back and forth is cheap.
 */
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import bash from "refractor/bash";
import { refractor } from "refractor/core";
import css from "refractor/css";
import diff from "refractor/diff";
import go from "refractor/go";
import javascript from "refractor/javascript";
import json from "refractor/json";
import jsxLanguage from "refractor/jsx";
import markdown from "refractor/markdown";
import markup from "refractor/markup";
import python from "refractor/python";
import rust from "refractor/rust";
import sql from "refractor/sql";
import toml from "refractor/toml";
import tsx from "refractor/tsx";
import typescript from "refractor/typescript";
import yaml from "refractor/yaml";
import styles from "./highlight.module.css";

for (const syntax of [
  markup,
  css,
  javascript,
  typescript,
  jsxLanguage,
  tsx,
  json,
  python,
  bash,
  diff,
  markdown,
  yaml,
  toml,
  rust,
  go,
  sql,
]) {
  refractor.register(syntax);
}
refractor.alias({
  bash: ["zsh", "console", "shellscript"],
  diff: ["patch"],
  javascript: ["mjs", "cjs"],
  typescript: ["mts", "cts"],
  json: ["jsonc", "json5"],
  rust: ["rs"],
  go: ["golang"],
  markup: ["htm", "xhtml"],
});

/** The hast tree refractor returns. */
export type HastRoot = ReturnType<typeof refractor.highlight>;
type HastNode = HastRoot["children"][number];

/** Prism token types (and aliases) → this module's classes. Unlisted tokens keep the base colour. */
const TOKEN_CLASS: Readonly<Record<string, string | undefined>> = {
  comment: styles.comment,
  prolog: styles.comment,
  doctype: styles.comment,
  cdata: styles.comment,
  shebang: styles.comment,
  punctuation: styles.punctuation,
  operator: styles.operator,
  entity: styles.operator,
  url: styles.operator,
  keyword: styles.keyword,
  atrule: styles.keyword,
  important: styles.keyword,
  rule: styles.keyword,
  "control-flow": styles.keyword,
  coord: styles.keyword,
  string: styles.string,
  char: styles.string,
  "attr-value": styles.string,
  "template-string": styles.string,
  "triple-quoted-string": styles.string,
  number: styles.number,
  boolean: styles.number,
  constant: styles.number,
  symbol: styles.number,
  regex: styles.regex,
  function: styles.function,
  "function-variable": styles.function,
  method: styles.function,
  "class-name": styles.function,
  "maybe-class-name": styles.function,
  builtin: styles.function,
  decorator: styles.function,
  property: styles.property,
  "attr-name": styles.property,
  key: styles.property,
  tag: styles.property,
  selector: styles.property,
  variable: styles.property,
  namespace: styles.namespace,
  title: styles.title,
  inserted: styles.inserted,
  deleted: styles.deleted,
  bold: styles.bold,
  italic: styles.italic,
};

function mapClasses(node: HastNode | HastRoot): void {
  if (node.type === "element") {
    const raw = node.properties.className;
    const names = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
    const mapped = names.map((name) => TOKEN_CLASS[name]).filter((name): name is string => !!name);
    if (mapped.length > 0) node.properties.className = mapped;
    else delete node.properties.className;
  }
  if ("children" in node) {
    for (const child of node.children) mapClasses(child as HastNode);
  }
}

/** Lower-cased language name, or null for none / plain text. */
export function normalizeLanguage(language: string | null | undefined): string | null {
  const name = language?.trim().toLowerCase() ?? "";
  if (name === "" || name === "text" || name === "plaintext" || name === "txt") return null;
  return name;
}

export function isHighlightable(language: string | null | undefined): boolean {
  const name = normalizeLanguage(language);
  return name !== null && refractor.registered(name);
}

const CACHE_LIMIT = 200;
const cache = new Map<string, ReactNode>();

/**
 * Highlighted React elements for `code`, or null when the language is unknown (the caller shows
 * plain text). React elements are immutable, so cached ones can be rendered again as they are.
 */
export function highlightCode(code: string, language: string | null | undefined): ReactNode {
  const name = normalizeLanguage(language);
  if (name === null || !refractor.registered(name)) return null;
  const key = `${name}\u0000${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh its place: the map's order is the eviction order.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let result: ReactNode = null;
  try {
    const tree = refractor.highlight(code, name);
    mapClasses(tree);
    result = toJsxRuntime(tree, { Fragment, jsx, jsxs });
  } catch {
    // A grammar that throws on odd input falls back to plain text.
    result = null;
  }
  cache.set(key, result);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return result;
}

/** For tests: how many highlighted blocks are cached. */
export function highlightCacheSize(): number {
  return cache.size;
}
