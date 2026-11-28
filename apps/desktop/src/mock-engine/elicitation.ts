/**
 * A scripted MCP server's request for input (Phase 4, MCP elicitation), for a prompt that asks
 * for an "MCP form" (a form with one field of each kind) or an "MCP page" (a page to open): the
 * model calls the mock tracker server's tool, and while the call runs the server asks. The answer
 * (`elicitation.respond`) ends the call with what the server would say, as decisions do
 * (generate.ts, `decisionResult`).
 */
import type { ElicitationField } from "@dawg/protocol";
import { WORKING } from "./generate.ts";
import type { Step } from "./player.ts";
import { scaledDelay } from "./player.ts";
import type { MockSession } from "./session.ts";

const FORM_WORDS = /\bMCP form\b/i;
const PAGE_WORDS = /\bMCP (page|sign[- ]?in)\b/i;

/** Whether a prompt asks for the scripted request for input. */
export function asksForElicitation(text: string): boolean {
  return FORM_WORDS.test(text) || PAGE_WORDS.test(text);
}

const none = { title: null, description: null } as const;

/** The tracker's form: one field of each kind MCP allows. */
export const TRACKER_FIELDS: ElicitationField[] = [
  {
    ...none,
    name: "title",
    title: "Title",
    type: "string",
    required: true,
    format: null,
    minLength: 3,
    maxLength: 80,
    default: null,
  },
  {
    ...none,
    name: "reporter",
    title: "Your email",
    type: "string",
    required: true,
    format: "email",
    minLength: null,
    maxLength: null,
    default: null,
  },
  {
    ...none,
    name: "due",
    title: "Due date",
    type: "string",
    required: false,
    format: "date",
    minLength: null,
    maxLength: null,
    default: null,
  },
  {
    ...none,
    name: "estimate",
    title: "Estimate (hours)",
    type: "integer",
    required: false,
    minimum: 1,
    maximum: 40,
    default: 2,
  },
  { ...none, name: "urgent", title: "Urgent", type: "boolean", required: false, default: false },
  {
    ...none,
    name: "priority",
    title: "Priority",
    description: "How soon it should be looked at",
    type: "select",
    required: true,
    options: [
      { value: "low", title: "Low" },
      { value: "normal", title: "Normal" },
      { value: "high", title: "High" },
    ],
    default: "normal",
  },
  {
    ...none,
    name: "labels",
    title: "Labels",
    type: "multiselect",
    required: false,
    options: [
      { value: "bug", title: "Bug" },
      { value: "docs", title: "Docs" },
      { value: "ui", title: "Interface" },
    ],
    minItems: null,
    maxItems: 2,
    default: ["bug"],
  },
];

export const TRACKER_URL = "https://tracker.example.com/connect?session=mock";

/**
 * The turn: working and `turn.started` at once (so the prompt's answer has the turn id), then the
 * model's call and, while it runs, the server's request.
 */
export function elicitationTurn(
  session: MockSession,
  speed: number,
  text: string,
): { turnId: string; steps: Step[] } {
  const page = PAGE_WORDS.test(text) && !FORM_WORDS.test(text);
  session.emit("session.status", { ...WORKING, message: "Working" });
  const turnId = session.ids.fresh("turn");
  session.emit("turn.started", {
    turnId,
    prompt: { content: [{ type: "text", text }], mentions: [] },
    command: null,
  });
  const messageId = session.ids.fresh("message");
  const toolCallId = session.ids.fresh("call");
  const requestId = session.ids.fresh("request");
  const toolName = page ? "mcp__tracker__connect" : "mcp__tracker__create_issue";
  const intro = page
    ? "I'll connect the tracker so I can read the project's issues."
    : "I'll file the issue in the tracker.";
  return {
    turnId,
    steps: [
      {
        delay: scaledDelay(500, speed),
        run: () => {
          session.emit("message.started", { turnId, messageId });
          session.emit("message.delta", { turnId, messageId, text: intro });
          session.emit("message.finished", {
            turnId,
            messageId,
            text: intro,
            reasoning: null,
            toolCalls: [{ toolCallId, toolName }],
          });
          session.emit("tool.started", {
            turnId,
            messageId,
            toolCallId,
            toolName,
            input: page ? {} : { project: "tally" },
          });
        },
      },
      {
        delay: scaledDelay(400, speed),
        run: () => {
          session.emit("elicitation.requested", {
            turnId,
            requestId,
            toolCallId,
            server: "tracker",
            message: page
              ? "Sign in to the tracker to let dawg read your issues."
              : "Tell the tracker about the new issue.",
            mode: page ? "url" : "form",
            fields: page ? [] : TRACKER_FIELDS,
            url: page ? TRACKER_URL : null,
          });
          session.emit("session.status", {
            status: "waiting",
            waitingOn: "elicitation",
            message: "Waiting for your input",
            queuePosition: null,
          });
        },
      },
    ],
  };
}
