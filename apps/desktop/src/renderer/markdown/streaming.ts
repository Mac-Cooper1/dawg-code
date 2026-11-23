/**
 * Makes a partial Markdown message render the way its finished form will, so a streaming reply
 * does not flicker: text inside a code fence does not flash as paragraphs, `**bold` does not show
 * its asterisks and then turn bold, and a half-typed list marker does not briefly become a heading
 * underline. Applied only while a message streams; finished text is rendered as it is.
 *
 * The rules are deliberately conservative approximations of CommonMark. When unsure, the text is
 * left alone: a rare literal asterisk for a moment is better than hiding what the model wrote.
 */

/** An opening or closing code fence: three or more backticks or tildes. */
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

/**
 * A last line made only of block markup so far: "-", "##", "1.", "> ", "``", "| --- |". It would
 * render as something else (a setext underline, an empty heading, literal backticks) until the
 * rest of the line arrives, so it is held back.
 */
const PARTIAL_MARKUP_LINE = /^\s*(?:[-=*_+#>`~|:\s]+|\d{1,9}[.)])\s*$/;

interface OpenFence {
  char: "`" | "~";
  length: number;
}

/** Whether a fence is still open after these lines, and which. */
function openFenceAfter(lines: readonly string[]): OpenFence | null {
  let open: OpenFence | null = null;
  for (const line of lines) {
    const match = FENCE.exec(line);
    if (!match) continue;
    const marker = match[1] ?? "";
    const rest = match[2] ?? "";
    const char = marker[0] === "~" ? "~" : "`";
    if (open === null) {
      // A backtick fence's info string cannot contain backticks.
      if (char === "`" && rest.includes("`")) continue;
      open = { char, length: marker.length };
    } else if (char === open.char && marker.length >= open.length && rest.trim() === "") {
      open = null;
    }
  }
  return open;
}

/** Closes a code fence left open at the end of the text. */
export function closeOpenFence(text: string): string {
  const open = openFenceAfter(text.split("\n"));
  if (open === null) return text;
  const fence = open.char.repeat(open.length);
  return text.endsWith("\n") ? `${text}${fence}` : `${text}\n${fence}`;
}

const PUNCTUATION_OR_SPACE = /[\s\p{P}\p{S}]/u;

function isBoundary(char: string | undefined): boolean {
  return char === undefined || PUNCTUATION_OR_SPACE.test(char);
}

/**
 * Closers for emphasis, strikethrough and code spans left open in the last paragraph, innermost
 * first. Underscores count only at word boundaries (snake_case is not emphasis), and a `*` that
 * starts a list item or stands between spaces ("2 * 3") is not emphasis either.
 */
function inlineClosers(paragraph: string): string {
  // Code spans first: inside an open one, nothing else is markup.
  const backtickRuns = paragraph.match(/`+/g) ?? [];
  let codeOpen: number | null = null;
  for (const run of backtickRuns) {
    if (codeOpen === null) codeOpen = run.length;
    else if (run.length === codeOpen) codeOpen = null;
  }
  let text = paragraph;
  let closers = "";
  if (codeOpen !== null) {
    closers = "`".repeat(codeOpen);
    text = text.slice(0, text.lastIndexOf("`".repeat(codeOpen)));
  }
  // Complete code spans, link destinations and bare URLs cannot open emphasis.
  text = text
    .replace(/(`+)[\s\S]*?\1/g, " ")
    .replace(/\]\([^)]*\)/g, "] ")
    .replace(/\bhttps?:\/\/\S+/g, " ");

  let italicStar = false;
  let boldStar = false;
  let italicUnderscore = false;
  let boldUnderscore = false;
  let strike = false;
  const runs = /(\*+|_+|~+)/g;
  for (let match = runs.exec(text); match !== null; match = runs.exec(text)) {
    const run = match[0];
    const before = text[match.index - 1];
    const after = text[match.index + run.length];
    const lineStart = before === undefined || before === "\n";
    if (run[0] === "*") {
      if (lineStart && run.length === 1 && after === " ") continue; // a list bullet
      if (isBoundary(before) && after !== undefined && /\s/.test(after)) continue; // "2 * 3"
      if (run.length >= 2) boldStar = !boldStar;
      if (run.length % 2 === 1) italicStar = !italicStar;
    } else if (run[0] === "_") {
      if (!isBoundary(before) && !isBoundary(after)) continue; // snake_case
      if (run.length >= 2) boldUnderscore = !boldUnderscore;
      if (run.length % 2 === 1) italicUnderscore = !italicUnderscore;
    } else if (run.length === 2) {
      strike = !strike;
    }
  }
  if (italicStar) closers += "*";
  if (boldStar) closers += "**";
  if (italicUnderscore) closers += "_";
  if (boldUnderscore) closers += "__";
  if (strike) closers += "~~";
  return closers;
}

/** Hides a link that is still being typed, or closes its destination. */
function settleLink(paragraph: string): { text: string; closer: string } {
  // "[label](https://exa" → close the destination.
  if (/\]\([^)\s]*$/.test(paragraph)) return { text: paragraph, closer: ")" };
  // "[label" → drop the bracket until the label is closed, so it does not flash as text.
  const bracket = /\[[^\]\n]*$/.exec(paragraph);
  if (bracket && !paragraph.slice(bracket.index).includes("`")) {
    return {
      text: paragraph.slice(0, bracket.index) + paragraph.slice(bracket.index + 1),
      closer: "",
    };
  }
  return { text: paragraph, closer: "" };
}

/**
 * Prepares streaming Markdown for rendering: holds back a last line that is only block markup,
 * closes an open code fence, and otherwise closes inline markup left open in the last paragraph.
 */
export function prepareStreamingMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const last = lines[lines.length - 1] ?? "";
  const fenceBefore = openFenceAfter(lines.slice(0, -1));
  if (fenceBefore !== null) {
    // Inside a code block every line is code; only the fence needs closing.
    return closeOpenFence(lines.join("\n"));
  }
  if (lines.length > 0 && last.trim() !== "" && PARTIAL_MARKUP_LINE.test(last)) {
    // A complete fence line opens a block: keep it so the code block appears at once.
    if (!/^\s*(`{3,}|~{3,})\s*$/.test(last)) lines.pop();
  }
  const joined = lines.join("\n");
  if (openFenceAfter(lines) !== null) return closeOpenFence(joined);

  // Trailing blank lines render as nothing, and closers must touch the text they close.
  const trimmed = joined.replace(/\s+$/, "");
  const paragraphStart = trimmed.lastIndexOf("\n\n") + 1;
  const head = trimmed.slice(0, paragraphStart);
  let paragraph = trimmed.slice(paragraphStart);
  // A marker with nothing after it yet ("Hello **") is removed rather than closed.
  paragraph = paragraph.replace(/(^|\s)[*_~`]+$/, "$1").replace(/[ \t]+$/, "");
  const link = settleLink(paragraph);
  return head + link.text + link.closer + inlineClosers(link.text);
}
