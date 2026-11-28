/**
 * The hook events Claude Code documents (code.claude.com/docs/en/hooks, "Hook events"), and how
 * far dawg runs each. The spec (Phase 4, Hooks) builds them in tiers by how often real setups use
 * them: tiers 1 and 2 run with every handler type, and tier 3 events run as each underlying
 * feature exists.
 */

/** Tier 1: the events this build runs. */
export const TIER_1_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "SessionEnd",
  "Notification",
] as const;
export type Tier1Event = (typeof TIER_1_EVENTS)[number];

/** Tier 2: next in the spec's build order. */
export const TIER_2_EVENTS = [
  "PermissionRequest",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
] as const;

export type Tier2Event = (typeof TIER_2_EVENTS)[number];

/** Tier 2 events dawg runs: all of them. */
export const RUNNING_TIER_2_EVENTS: readonly Tier2Event[] = TIER_2_EVENTS;

/** Tier 3 events dawg runs: those whose feature exists, documented well enough to build. */
export const RUNNING_TIER_3_EVENTS = [
  "PostToolBatch",
  "UserPromptExpansion",
  "StopFailure",
  "Elicitation",
  "ElicitationResult",
] as const;
export type RunningTier3Event = (typeof RUNNING_TIER_3_EVENTS)[number];

/** Every event dawg runs. */
export type RunningEvent = Tier1Event | Tier2Event | RunningTier3Event;

/** Every event the hooks reference documents, in its order. */
export const DOCUMENTED_EVENTS: readonly string[] = [
  "SessionStart",
  "Setup",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "PreSkillShellCommand",
  "PreToolUse",
  "PermissionRequest",
  "PermissionDenied",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Notification",
  "MessageDisplay",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "TeammateIdle",
  "InstructionsLoaded",
  "ConfigChange",
  "CwdChanged",
  "DirectoryAdded",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreCompact",
  "PostCompact",
  "PreModelSwitch",
  "PostModelSwitch",
  "Elicitation",
  "ElicitationResult",
  "SessionEnd",
];

/** Handler types the hooks reference documents, in the spec's build order. */
export const HANDLER_TYPES = ["command", "http", "prompt", "agent", "mcp_tool"] as const;

const TIER_1 = new Set<string>(TIER_1_EVENTS);
const TIER_2 = new Set<string>(TIER_2_EVENTS);
const DOCUMENTED = new Set<string>(DOCUMENTED_EVENTS);

export function isTier1Event(event: string): event is Tier1Event {
  return TIER_1.has(event);
}

const RUNNING_TIER_3 = new Set<string>(RUNNING_TIER_3_EVENTS);

/** Whether dawg runs hooks on this event. */
export function isRunningEvent(event: string): event is RunningEvent {
  return TIER_1.has(event) || TIER_2.has(event) || RUNNING_TIER_3.has(event);
}

export function eventTier(event: string): 1 | 2 | 3 | null {
  if (TIER_1.has(event)) return 1;
  if (TIER_2.has(event)) return 2;
  return DOCUMENTED.has(event) ? 3 : null;
}

/**
 * Events whose matcher Claude Code ignores ("No matcher support (always fires)" in the
 * reference); a matcher written on one of them is not an error, it just does nothing.
 */
export const EVENTS_WITHOUT_MATCHER: ReadonlySet<string> = new Set([
  "UserPromptSubmit",
  "PostToolBatch",
  "Stop",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "WorktreeCreate",
  "WorktreeRemove",
  "MessageDisplay",
  "CwdChanged",
]);

/**
 * Events on which a handler's `if` rule is evaluated; on the others "a hook with `if` set
 * doesn't run" (reference, the `if` field).
 */
export const EVENTS_WITH_IF: ReadonlySet<string> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "PreSkillShellCommand",
]);

/**
 * Events where every handler type runs ("Prompt-based hooks": "Events that support all five hook
 * types"). Elsewhere `prompt` and `agent` hooks do not run, and PermissionRequest takes every type
 * but `agent`.
 */
const ALL_TYPES_EVENTS: ReadonlySet<string> = new Set([
  "PermissionDenied",
  "PostToolBatch",
  "PostToolUse",
  "PostToolUseFailure",
  "PreToolUse",
  "Stop",
  "SubagentStop",
  "TaskCompleted",
  "TaskCreated",
  "TeammateIdle",
  "UserPromptExpansion",
  "UserPromptSubmit",
]);

/**
 * Whether Claude Code runs a handler of this type on this event, as the reference lists them:
 * command everywhere; http and mcp_tool everywhere but Setup (and http not on SessionStart);
 * prompt on the all-types events and PermissionRequest; agent on the all-types events only.
 */
export function handlerRunsOn(type: string, event: string): boolean {
  switch (type) {
    case "command":
      return true;
    case "http":
      return event !== "Setup" && event !== "SessionStart";
    case "mcp_tool":
      return event !== "Setup";
    case "prompt":
      return ALL_TYPES_EVENTS.has(event) || event === "PermissionRequest";
    case "agent":
      return ALL_TYPES_EVENTS.has(event);
    default:
      return false;
  }
}
