/**
 * An MCP server's request for input at the terminal (interactive mode; a `-p` run declares no
 * one to ask, so the engine declines for it). Form mode asks for each field in turn, as
 * questions are asked, checks each answer against the form, then shows the answers to send or
 * change. URL mode shows the address and its site, and opens it in the browser only when the
 * person says so. `/decline` and `/cancel` at any prompt stop there.
 *
 * The server's message, titles and descriptions are untrusted: they are printed as plain text
 * with control characters taken out, so they cannot move the cursor or recolour the terminal.
 */
import {
  type ElicitationAction,
  type ElicitationContent,
  type ElicitationField,
  type EventPayload,
  elicitationFieldIssue,
} from "@dawg/protocol";

export interface ElicitationAnswer {
  action: ElicitationAction;
  content?: ElicitationContent;
}

export interface ElicitationTerminal {
  /** Writes a question and reads the answer; null at the end of input or when it closed. */
  ask(question: string): Promise<string | null>;
  line(text: string): void;
  /** Opens a web address in the browser; false when it could not. */
  open(url: string): Promise<boolean>;
}

type Payload = EventPayload<"elicitation.requested">;

/** Takes out control characters (escape sequences, carriage returns) from a server's text. */
export function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

class Stop extends Error {
  readonly action: "decline" | "cancel";
  constructor(action: "decline" | "cancel") {
    super(action);
    this.action = action;
  }
}

async function prompt(terminal: ElicitationTerminal, question: string): Promise<string> {
  const line = await terminal.ask(question);
  if (line === null) throw new Stop("cancel");
  const text = line.trim();
  if (/^\/decline$/i.test(text)) throw new Stop("decline");
  if (/^\/cancel$/i.test(text)) throw new Stop("cancel");
  return text;
}

function label(field: ElicitationField): string {
  return plain(field.title ?? field.name);
}

function optionName(option: { value: string; title: string | null }): string {
  return plain(option.title ?? option.value);
}

/** The value as the person sees it, for defaults and the summary. */
function shown(field: ElicitationField, value: unknown): string {
  if (field.type === "boolean") return value === true ? "yes" : "no";
  if (field.type === "select") {
    const option = field.options.find((o) => o.value === value);
    return option === undefined ? String(value) : optionName(option);
  }
  if (field.type === "multiselect" && Array.isArray(value)) {
    if (value.length === 0) return "none";
    return value
      .map((v) => {
        const option = field.options.find((o) => o.value === v);
        return option === undefined ? String(v) : optionName(option);
      })
      .join(", ");
  }
  return plain(String(value));
}

/** What the field takes, in a few words. */
function hint(field: ElicitationField): string {
  const parts: string[] = [];
  if (field.required) parts.push("required");
  switch (field.type) {
    case "string":
      if (field.format === "email") parts.push("an email address");
      if (field.format === "uri") parts.push("a full address");
      if (field.format === "date") parts.push("YYYY-MM-DD");
      if (field.format === "date-time") parts.push("such as 2026-11-27T09:30:00Z");
      if (field.minLength !== null && field.maxLength !== null) {
        parts.push(`${field.minLength} to ${field.maxLength} characters`);
      } else if (field.minLength !== null) parts.push(`at least ${field.minLength} characters`);
      else if (field.maxLength !== null) parts.push(`at most ${field.maxLength} characters`);
      break;
    case "number":
    case "integer": {
      if (field.type === "integer") parts.push("a whole number");
      const { minimum: min, maximum: max } = field;
      if (min !== null && max !== null) parts.push(`${min} to ${max}`);
      else if (min !== null) parts.push(`${min} or more`);
      else if (max !== null) parts.push(`${max} or less`);
      break;
    }
    case "boolean":
      parts.push("y or n");
      break;
    case "select":
      parts.push("a number");
      break;
    case "multiselect":
      parts.push("numbers separated by commas");
      if (field.minItems !== null) parts.push(`at least ${field.minItems}`);
      if (field.maxItems !== null) parts.push(`at most ${field.maxItems}`);
      break;
  }
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

/** What a typed line means for the field: the value, or what is wrong with it. */
export function valueFromText(
  field: ElicitationField,
  text: string,
): { value: unknown } | { problem: string } {
  switch (field.type) {
    case "string":
      return { value: text };
    case "number":
    case "integer": {
      const value = Number(text);
      return text === "" || Number.isNaN(value) ? { problem: "Enter a number." } : { value };
    }
    case "boolean":
      if (/^(y|yes|true)$/i.test(text)) return { value: true };
      if (/^(n|no|false)$/i.test(text)) return { value: false };
      return { problem: "Choose yes or no." };
    case "select": {
      const n = Number(text);
      const byNumber = Number.isInteger(n) ? field.options[n - 1] : undefined;
      const byValue = field.options.find((o) => o.value === text || o.title === text);
      const option = byNumber ?? byValue;
      return option === undefined
        ? { problem: "Pick one of the choices." }
        : { value: option.value };
    }
    case "multiselect": {
      const values: string[] = [];
      for (const word of text.split(/[\s,]+/).filter((w) => w !== "")) {
        const n = Number(word);
        const option =
          (Number.isInteger(n) ? field.options[n - 1] : undefined) ??
          field.options.find((o) => o.value === word);
        if (option === undefined) return { problem: "Pick only from the choices." };
        values.push(option.value);
      }
      return { value: values };
    }
  }
}

async function askField(
  terminal: ElicitationTerminal,
  field: ElicitationField,
  previous: unknown,
): Promise<unknown> {
  const description = field.description === null ? "" : `: ${plain(field.description)}`;
  terminal.line(`${label(field)}${hint(field)}${description}`);
  if (field.type === "select" || field.type === "multiselect") {
    field.options.forEach((option, i) => {
      terminal.line(`  ${i + 1}. ${optionName(option)}`);
    });
  }
  const fallback = previous !== undefined ? previous : (field.default ?? undefined);
  for (;;) {
    const keep = fallback === undefined ? "" : ` [${shown(field, fallback)}]`;
    const text = await prompt(terminal, `${label(field)}${keep}: `);
    if (text === "") {
      if (fallback !== undefined) return fallback;
      if (!field.required) return undefined;
      terminal.line("This is required.");
      continue;
    }
    const read = valueFromText(field, text);
    if ("problem" in read) {
      terminal.line(read.problem);
      continue;
    }
    const value = read.value;
    const issue = elicitationFieldIssue(field, value);
    if (issue !== null) {
      terminal.line(issue);
      continue;
    }
    return value;
  }
}

async function answerForm(
  terminal: ElicitationTerminal,
  payload: Payload,
): Promise<ElicitationAnswer> {
  terminal.line(
    "Answer each field. Enter keeps the value in brackets or skips an optional field; /decline or /cancel stops.",
  );
  let content: ElicitationContent = {};
  for (;;) {
    const next: ElicitationContent = {};
    for (const field of payload.fields) {
      const value = await askField(terminal, field, content[field.name]);
      if (value !== undefined) next[field.name] = value as ElicitationContent[string];
    }
    content = next;
    terminal.line(`To send to ${plain(payload.server)}:`);
    for (const field of payload.fields) {
      const value = content[field.name];
      terminal.line(
        `  ${label(field)}: ${value === undefined ? "(left out)" : shown(field, value)}`,
      );
    }
    for (;;) {
      const text = (
        await prompt(terminal, "Send? y = send, e = change the answers, n = decline, c = cancel: ")
      ).toLowerCase();
      if (text === "y" || text === "yes") return { action: "accept", content };
      if (text === "e") break;
      if (text === "n" || text === "no") return { action: "decline" };
      if (text === "c") return { action: "cancel" };
    }
  }
}

async function answerUrl(
  terminal: ElicitationTerminal,
  payload: Payload,
): Promise<ElicitationAnswer> {
  const url = payload.url ?? "";
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    // The engine sends only addresses it could read.
  }
  terminal.line(`  Site: ${host}`);
  terminal.line(`  Address: ${plain(url)}`);
  if (host.includes("xn--")) {
    terminal.line(
      "  The site's name uses characters from other alphabets, so it may imitate a site you know.",
    );
  }
  for (;;) {
    const text = (
      await prompt(terminal, "Open it in your browser? o = open, n = decline, c = cancel: ")
    ).toLowerCase();
    if (text === "o" || text === "open" || text === "y") {
      const opened = await terminal.open(url);
      terminal.line(
        opened
          ? "Opened in your browser. Finish there; the server goes on when it is done."
          : "Could not open the browser. Open the address above yourself; the server goes on when it is done.",
      );
      return { action: "accept" };
    }
    if (text === "n" || text === "no") return { action: "decline" };
    if (text === "c") return { action: "cancel" };
  }
}

/** Asks the person at the terminal and resolves with their answer. */
export async function answerElicitation(
  payload: Payload,
  terminal: ElicitationTerminal,
): Promise<ElicitationAnswer> {
  const server = plain(payload.server);
  const message = plain(payload.message).trim();
  // A subagent's request is raised in its parent's session: say which agent's call it is.
  const agent = payload.agent;
  const who =
    agent === undefined
      ? ""
      : ` (${agent.agentId}, ${plain(agent.agentType)} agent: ${plain(agent.description).replace(/\s+/g, " ").trim()})`;
  terminal.line(
    payload.mode === "url"
      ? `The MCP server ${server} asks you to open a page${who}${message === "" ? "." : `: ${message}`}`
      : `The MCP server ${server} asks for input${who}${message === "" ? "." : `: ${message}`}`,
  );
  try {
    return payload.mode === "url"
      ? await answerUrl(terminal, payload)
      : await answerForm(terminal, payload);
  } catch (error) {
    if (error instanceof Stop) return { action: error.action };
    throw error;
  }
}
