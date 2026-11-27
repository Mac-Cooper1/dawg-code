/**
 * HTML to Markdown for WebFetch, written for this project (no dependency): a forgiving
 * tokenizer, a small tree builder that copes with the usual unclosed tags, and a renderer that
 * keeps what a reader needs (headings, paragraphs, links, lists, code, tables, emphasis) and
 * drops the rest.
 *
 * Left out on purpose:
 * - scripts, styles, forms, embedded media and navigation bars, which are noise to a reader;
 * - anything hidden from a person viewing the page (`hidden`, `aria-hidden="true"`,
 *   `display:none`), since hidden text is a favourite place for instructions aimed at a model.
 *
 * When the page marks its main content (`<main>`, `role="main"`, or a single `<article>`), only
 * that is converted, with the page title.
 *
 * Linear in the input; nesting deeper than `MAX_DEPTH` is flattened instead of recursed into.
 */

export interface ConvertedPage {
  /** The page's `<title>`, or null. */
  title: string | null;
  markdown: string;
}

interface Element {
  type: "element";
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
interface Text {
  type: "text";
  text: string;
}
type Node = Element | Text;

const MAX_DEPTH = 300;

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements whose content is raw text up to their end tag. */
const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);

/** Dropped with everything inside. */
const SKIP = new Set([
  "head",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "math",
  "canvas",
  "iframe",
  "object",
  "embed",
  "video",
  "audio",
  "map",
  "form",
  "input",
  "select",
  "button",
  "textarea",
  "option",
  "dialog",
  "nav",
]);

const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "body",
  "center",
  "details",
  "dialog",
  "div",
  "dl",
  "dd",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "header",
  "hgroup",
  "html",
  "main",
  "p",
  "section",
  "summary",
]);

/** Start tags that close an open `<p>`. */
const CLOSES_P = new Set([
  ...BLOCK,
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "ol",
  "pre",
  "table",
  "ul",
]);

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  zwj: "",
  zwnj: "",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  minus: "−",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  lsaquo: "‹",
  rsaquo: "›",
  bull: "•",
  middot: "·",
  times: "×",
  divide: "÷",
  deg: "°",
  plusmn: "±",
  para: "¶",
  sect: "§",
  cent: "¢",
  pound: "£",
  euro: "€",
  yen: "¥",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  rArr: "⇒",
  lArr: "⇐",
  le: "≤",
  ge: "≥",
  ne: "≠",
  asymp: "≈",
  infin: "∞",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  sup1: "¹",
  sup2: "²",
  sup3: "³",
  micro: "µ",
  dagger: "†",
  Dagger: "‡",
  prime: "′",
  Prime: "″",
  check: "✓",
  iexcl: "¡",
  iquest: "¿",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  agrave: "à",
  egrave: "è",
  ograve: "ò",
  acirc: "â",
  ecirc: "ê",
  ocirc: "ô",
  auml: "ä",
  euml: "ë",
  iuml: "ï",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  ntilde: "ñ",
  ccedil: "ç",
  aring: "å",
  aelig: "æ",
  oslash: "ø",
};

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});?/gi,
    (match, body: string) => {
      if (body.startsWith("#")) {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        if (
          !Number.isFinite(code) ||
          code <= 0 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
        ) {
          return "\uFFFD";
        }
        return String.fromCodePoint(code);
      }
      const named = NAMED[body] ?? NAMED[body.toLowerCase()];
      return named ?? match;
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Tokenizer and tree
// ---------------------------------------------------------------------------------------------

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    const name = (m[1] as string).toLowerCase();
    if (name in attrs) continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Builds a tree from HTML. Never throws. */
export function parseHtml(html: string): Element {
  const root: Element = { type: "element", tag: "#root", attrs: {}, children: [] };
  const stack: Element[] = [root];
  const top = () => stack[stack.length - 1] as Element;
  const addText = (text: string) => {
    if (text === "") return;
    const children = top().children;
    const last = children[children.length - 1];
    if (last?.type === "text") last.text += text;
    else children.push({ type: "text", text });
  };
  const closeTo = (tag: string, limit: ReadonlySet<string> = new Set()) => {
    for (let i = stack.length - 1; i > 0; i--) {
      const t = (stack[i] as Element).tag;
      if (t === tag) {
        stack.length = i;
        return true;
      }
      if (limit.has(t)) return false;
    }
    return false;
  };

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      addText(decodeEntities(html.slice(i)));
      break;
    }
    if (lt > i) addText(decodeEntities(html.slice(i, lt)));
    const next = html[lt + 1] ?? "";
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (next === "!" || next === "?") {
      const end = html.indexOf(">", lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (next === "/") {
      const m = /^<\/([a-zA-Z][a-zA-Z0-9:-]*)[^>]*>?/.exec(html.slice(lt, lt + 200));
      if (m === null) {
        addText("</");
        i = lt + 2;
        continue;
      }
      const tag = (m[1] as string).toLowerCase();
      const end = html.indexOf(">", lt);
      i = end === -1 ? n : end + 1;
      if (tag === "p" && !closeTo("p", new Set(["div", "td", "th", "li", "blockquote"]))) {
        // A stray </p> stands for an empty paragraph, as browsers read it.
        continue;
      }
      if (tag !== "p") closeTo(tag);
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) {
      addText("<");
      i = lt + 1;
      continue;
    }
    // A start tag: find its end, skipping quoted attribute values.
    let j = lt + 1;
    let quote: string | null = null;
    while (j < n) {
      const c = html[j];
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
      j++;
    }
    const inner = html.slice(lt + 1, j);
    i = j + 1;
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(inner);
    const tag = (nameMatch?.[0] ?? "").toLowerCase();
    const attrs = parseAttributes(inner.slice(tag.length));
    const element: Element = { type: "element", tag, attrs, children: [] };

    // Implied end tags, as a browser would close them.
    if (CLOSES_P.has(tag))
      closeTo("p", new Set(["div", "td", "th", "li", "blockquote", "section", "article"]));
    if (tag === "li") closeTo("li", new Set(["ul", "ol", "menu"]));
    if (tag === "dt" || tag === "dd") {
      closeTo("dt", new Set(["dl"])) || closeTo("dd", new Set(["dl"]));
    }
    if (tag === "tr") closeTo("tr", new Set(["table", "thead", "tbody", "tfoot"]));
    if (tag === "td" || tag === "th") {
      closeTo("td", new Set(["tr", "table"])) || closeTo("th", new Set(["tr", "table"]));
    }
    if (tag === "option") closeTo("option", new Set(["select"]));

    top().children.push(element);
    if (RAW_TEXT.has(tag)) {
      const close = new RegExp(`</${tag}\\s*>`, "i");
      const rest = html.slice(i);
      const m = close.exec(rest);
      const body = m === null ? rest : rest.slice(0, m.index);
      element.children.push({
        type: "text",
        text: tag === "title" || tag === "textarea" ? decodeEntities(body) : body,
      });
      i = m === null ? n : i + m.index + m[0].length;
      continue;
    }
    if (VOID.has(tag) || inner.endsWith("/") || stack.length > MAX_DEPTH) continue;
    stack.push(element);
  }
  return root;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/**
 * Private-use characters stand for list indentation (INDENT, one space) and for code blocks
 * (U+E000 around the block's number) until the very end; a page's own copies of them are removed
 * first, so it cannot forge either.
 */
const INDENT = "\uE001";

interface RenderContext {
  base: URL | null;
  pre: boolean;
  /** Fenced code blocks, put in at the end so whitespace handling never touches them. */
  blocks: string[];
}

function isHidden(el: Element): boolean {
  const a = el.attrs;
  if ("hidden" in a) return true;
  if (a["aria-hidden"] === "true") return true;
  const style = (a.style ?? "").toLowerCase().replace(/\s+/g, "");
  return style.includes("display:none") || style.includes("visibility:hidden");
}

function absolute(href: string, base: URL | null): string | null {
  const value = href.trim();
  if (value === "" || value.startsWith("#")) return null;
  try {
    const url = base === null ? new URL(value) : new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function block(content: string): string {
  const body = content.trim();
  return body === "" ? "" : `\n\n${body}\n\n`;
}

/** Whitespace around line breaks inside a block goes; the text itself stays. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textOf(el: Element): string {
  let out = "";
  for (const child of el.children) out += child.type === "text" ? child.text : textOf(child);
  return out.replace(/[\uE000\uE001]/g, "");
}

function children(el: Element, ctx: RenderContext): string {
  let out = "";
  for (const child of el.children) out += render(child, ctx);
  return out;
}

function wrapInline(marker: string, inner: string): string {
  const trimmed = inner.trim();
  if (trimmed === "") return inner;
  const lead = inner.startsWith(" ") ? " " : "";
  const trail = inner.endsWith(" ") ? " " : "";
  return `${lead}${marker}${trimmed}${marker}${trail}`;
}

function fence(code: string, language: string): string {
  let ticks = "```";
  while (code.includes(ticks)) ticks += "`";
  return `${ticks}${language}\n${code.replace(/\n+$/, "")}\n${ticks}`;
}

function codeLanguage(el: Element): string {
  const classes = `${el.attrs.class ?? ""} ${
    el.children.find((c): c is Element => c.type === "element" && c.tag === "code")?.attrs.class ??
    ""
  }`;
  const m = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(classes);
  return m?.[1] ?? "";
}

function listItems(el: Element, ctx: RenderContext): string {
  const ordered = el.tag === "ol";
  let index = Number.parseInt(el.attrs.start ?? "1", 10);
  if (!Number.isFinite(index)) index = 1;
  const lines: string[] = [];
  for (const child of el.children) {
    if (child.type === "text") {
      if (child.text.trim() !== "") lines.push(`- ${child.text.trim()}`);
      continue;
    }
    if (isHidden(child) || SKIP.has(child.tag)) continue;
    const marker = ordered ? `${index}. ` : "- ";
    index += 1;
    const body = tidy(child.tag === "li" ? children(child, ctx) : render(child, ctx));
    if (body === "") continue;
    // Indentation is written as INDENT so whitespace tidying cannot take it away.
    const pad = INDENT.repeat(marker.length);
    lines.push(
      body
        .split("\n")
        .map((line, i) => (i === 0 ? `${marker}${line}` : line === "" ? "" : `${pad}${line}`))
        .join("\n"),
    );
  }
  return block(lines.join("\n"));
}

function cellText(el: Element, ctx: RenderContext): string {
  return tidy(children(el, ctx)).replace(/\n+/g, " ").replace(/\|/g, "\\|");
}

function table(el: Element, ctx: RenderContext): string {
  const rows: string[][] = [];
  const visit = (node: Element) => {
    for (const child of node.children) {
      if (child.type !== "element" || isHidden(child)) continue;
      if (child.tag === "tr") {
        rows.push(
          child.children
            .filter((c): c is Element => c.type === "element" && (c.tag === "td" || c.tag === "th"))
            .map((c) => cellText(c, ctx)),
        );
      } else if (child.tag === "thead" || child.tag === "tbody" || child.tag === "tfoot") {
        visit(child);
      } else if (child.tag === "caption") {
        rows.unshift([]);
        rows[0] = [cellText(child, ctx)];
      }
    }
  };
  visit(el);
  const filled = rows.filter((r) => r.some((c) => c !== ""));
  if (filled.length === 0) return "";
  const width = Math.max(...filled.map((r) => r.length));
  // A one-column table is layout, not data: its cells read as paragraphs.
  if (width <= 1) return block(filled.map((r) => r[0] ?? "").join("\n\n"));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const [head, ...body] = filled as [string[], ...string[][]];
  return block(
    [
      line(head),
      `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
      ...body.map(line),
    ].join("\n"),
  );
}

function render(node: Node, ctx: RenderContext): string {
  if (node.type === "text") {
    // The page's own control characters go, so it cannot forge the placeholders used here.
    const text = node.text.replace(/[\uE000\uE001]/g, "");
    return ctx.pre ? text : text.replace(/\s+/g, " ");
  }
  const el = node;
  if (SKIP.has(el.tag) || el.tag === "title" || isHidden(el)) return "";
  switch (el.tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = tidy(children(el, ctx)).replace(/\n+/g, " ");
      return text === "" ? "" : block(`${"#".repeat(Number(el.tag[1]))} ${text}`);
    }
    case "br":
      return ctx.pre ? "\n" : "\n";
    case "hr":
      return block("---");
    case "pre": {
      const code = textOf(el).replace(/^\n/, "");
      if (code.trim() === "") return "";
      ctx.blocks.push(fence(code, codeLanguage(el)));
      return block(`\uE000${ctx.blocks.length - 1}\uE000`);
    }
    case "code":
    case "kbd":
    case "samp":
    case "tt": {
      if (ctx.pre) return textOf(el);
      const code = textOf(el).replace(/\s+/g, " ");
      if (code.trim() === "") return code;
      const ticks = code.includes("`") ? "``" : "`";
      return `${ticks}${code}${ticks}`;
    }
    case "strong":
    case "b":
      return wrapInline("**", children(el, ctx));
    case "em":
    case "i":
    case "cite":
      return wrapInline("*", children(el, ctx));
    case "s":
    case "del":
    case "strike":
      return wrapInline("~~", children(el, ctx));
    case "a": {
      const inner = children(el, ctx);
      const href = absolute(el.attrs.href ?? "", ctx.base);
      const label = inner.replace(/\s+/g, " ").trim();
      if (href === null || label === "") return inner;
      return `[${label.replace(/[[\]]/g, "\\$&")}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
    }
    case "img": {
      const alt = (el.attrs.alt ?? "").trim();
      const src = absolute(el.attrs.src ?? "", ctx.base);
      if (alt === "") return "";
      return src === null
        ? alt
        : `![${alt.replace(/[[\]]/g, "")}](${src.replace(/[()\s]/g, encodeURIComponent)})`;
    }
    case "ul":
    case "ol":
    case "menu":
      return listItems(el, ctx);
    case "li":
      return block(`- ${tidy(children(el, ctx))}`);
    case "blockquote": {
      const body = tidy(children(el, ctx));
      if (body === "") return "";
      return block(
        body
          .split("\n")
          .map((line) => (line === "" ? ">" : `> ${line}`))
          .join("\n"),
      );
    }
    case "table":
      return table(el, ctx);
    case "tr":
    case "td":
    case "th":
    case "thead":
    case "tbody":
    case "tfoot":
      // Outside a table (broken markup): read as text.
      return ` ${children(el, ctx)} `;
    case "dt":
      return block(`**${tidy(children(el, ctx))}**`);
    default:
      if (BLOCK.has(el.tag)) return block(children(el, ctx));
      return children(el, ctx);
  }
}

function find(root: Element, test: (el: Element) => boolean, limit = 2): Element[] {
  const found: Element[] = [];
  const walk = (el: Element) => {
    for (const child of el.children) {
      if (found.length >= limit) return;
      if (child.type !== "element") continue;
      if (test(child)) found.push(child);
      else walk(child);
    }
  };
  walk(root);
  return found;
}

/** The part of the page to convert: its main content when it marks one, else the whole. */
function mainContent(root: Element): Element {
  const main = find(root, (el) => el.tag === "main" || el.attrs.role === "main", 1);
  if (main[0] !== undefined && textOf(main[0]).trim() !== "") return main[0];
  const articles = find(root, (el) => el.tag === "article");
  if (articles.length === 1 && textOf(articles[0] as Element).trim() !== "") {
    return articles[0] as Element;
  }
  return root;
}

/** Converts a page. `baseUrl` makes relative links absolute (a `<base href>` wins over it). */
export function htmlToMarkdown(html: string, baseUrl?: string): ConvertedPage {
  const root = parseHtml(html);
  const titleEl = find(root, (el) => el.tag === "title", 1)[0];
  const title = titleEl ? textOf(titleEl).replace(/\s+/g, " ").trim() || null : null;
  let base: URL | null = null;
  try {
    base = baseUrl === undefined ? null : new URL(baseUrl);
    const baseEl = find(root, (el) => el.tag === "base" && typeof el.attrs.href === "string", 1)[0];
    if (baseEl?.attrs.href) base = new URL(baseEl.attrs.href, base ?? undefined);
  } catch {
    // An unusable <base> is ignored.
  }
  const ctx: RenderContext = { base, pre: false, blocks: [] };
  let text = tidy(render(mainContent(root), ctx));
  // Put the code blocks back, indented like the line that holds them (a list item's).
  text = text.replace(/^(.*?)\uE000(\d+)\uE000/gm, (_m, prefix: string, index: string) => {
    const code = ctx.blocks[Number(index)] ?? "";
    const rest = prefix.replace(/[^>\s\uE001]/g, " ");
    return code
      .split("\n")
      .map((line, i) => (i === 0 ? `${prefix}${line}` : `${rest}${line}`))
      .join("\n");
  });
  return { title, markdown: text.replaceAll(INDENT, " ") };
}
