/** Permission modes and effort levels as the UI names them. */
import type { PermissionMode } from "@dawg/protocol";

/** Colour family of the mode pill. */
export type ModeTone = "neutral" | "accent" | "blue" | "amber" | "red";

export interface ModeInfo {
  label: string;
  description: string;
  tone: ModeTone;
}

export const MODE_INFO: Record<PermissionMode, ModeInfo> = {
  default: {
    label: "Ask first",
    description: "Asks before every edit and command",
    tone: "neutral",
  },
  acceptEdits: {
    label: "Accept edits",
    description: "Edits apply; commands still ask",
    tone: "accent",
  },
  plan: { label: "Plan", description: "Reads and plans; changes nothing", tone: "blue" },
  dontAsk: {
    label: "Don’t ask",
    description: "Only what rules allow; the rest is refused",
    tone: "amber",
  },
  bypassPermissions: {
    label: "Bypass",
    description: "Everything runs without asking",
    tone: "red",
  },
};

/** Order in the mode menu. */
export const MODE_ORDER: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
];

/** Shift+Tab cycles through these. The other modes are reached from the menu only. */
export const MODE_CYCLE: readonly PermissionMode[] = ["default", "acceptEdits", "plan"];

export function nextMode(mode: PermissionMode): PermissionMode {
  const index = MODE_CYCLE.indexOf(mode);
  return MODE_CYCLE[(index + 1) % MODE_CYCLE.length] ?? "default";
}

/** Descriptions for effort levels a model may report. Unknown levels show no description. */
export const EFFORT_INFO: Record<string, string> = {
  minimal: "Barely thinks; for trivial edits",
  low: "Quickest; for small, clear edits",
  medium: "Faster replies, still plans ahead",
  high: "Thinks it through; good default for real work",
  xhigh: "Thinks longest; best for hard bugs",
  max: "No limit on thinking",
};
