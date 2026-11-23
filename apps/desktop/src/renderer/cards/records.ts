/**
 * The one-line records an answered (or no longer needed) decision card leaves in the transcript:
 * "You allowed this once", "You answered: Evenly, with the bill". Pure, so the wording is tested
 * on its own.
 */
import type { PermissionResponse, QuestionAnswer } from "@dawg/protocol";
import { MODE_INFO } from "../lib/modes.ts";
import type { PermissionItem, PlanItem, QuestionItem } from "../state/types.ts";

export const CANCELLED_RECORD = "No answer needed: the turn ended";

/** Rules an "always" answer saved: the edited ones it carried, or the request's suggestions. */
export function savedRules(item: PermissionItem): string[] {
  const response = item.response;
  if (response?.behavior === "allow" && response.rules !== undefined) return response.rules;
  return item.request.suggestions;
}

export function permissionRecord(item: PermissionItem): string {
  if (item.state === "cancelled") return CANCELLED_RECORD;
  const response: PermissionResponse | null = item.response;
  if (response === null) return "Answered";
  if (response.behavior === "deny") {
    return response.message ? `You denied it · note sent: “${response.message}”` : "You denied it";
  }
  if (response.scope === "once") return "You allowed this once";
  const rules = savedRules(item);
  if (rules.length === 0) return "You allowed it for this session";
  return `You allowed it always · ${rules.length === 1 ? "rule" : "rules"} saved: ${rules.join(", ")}`;
}

function answerText(answer: QuestionAnswer): string {
  const parts = [...answer.selected];
  if (answer.text) parts.push(`“${answer.text}”`);
  return parts.join(" · ");
}

export function questionRecord(item: QuestionItem): string {
  if (item.state === "cancelled") return CANCELLED_RECORD;
  const response = item.response;
  if (response === null) return "Answered";
  if (response.outcome === "dismissed") return "You dismissed the question";
  const answers = response.answers.map(answerText).filter((text) => text !== "");
  return answers.length > 0 ? `You answered: ${answers.join("; ")}` : "You answered";
}

export function planRecord(item: PlanItem): string {
  if (item.state === "cancelled") return CANCELLED_RECORD;
  const response = item.response;
  if (response === null) return "Answered";
  if (response.decision === "reject") return "You asked for changes · still planning";
  if (response.mode) return `You approved the plan · mode is now ${MODE_INFO[response.mode].label}`;
  if (item.modeBeforePlan)
    return `You approved the plan · back to ${MODE_INFO[item.modeBeforePlan].label}`;
  return "You approved the plan";
}
