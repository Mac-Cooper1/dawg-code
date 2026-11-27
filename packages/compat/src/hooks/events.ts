/**
 * The hook events Claude Code documents (code.claude.com/docs/en/hooks, "Hook events"), and how
 * far dawg runs each. The spec (Phase 4, Hooks) builds them in tiers by how often real setups use
 * them; this round runs tier 1 with `command` handlers.
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

/** Tier 2 events dawg runs already: the subagent events (Phase 4, Subagents). */
export const RUNNING_TIER_2_EVENTS = ["SubagentStart", "SubagentStop"] as const;
/** Every event dawg runs: tier 1, and the tier 2 events built so far. */
export type RunningEvent = Tier1Event | (typeof RUNNING_TIER_2_EVENTS)[number];

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

const RUNNING_TIER_2 = new Set<string>(RUNNING_TIER_2_EVENTS);

/** Whether dawg runs hooks on this event. */
export function isRunningEvent(event: string): event is RunningEvent {
  return TIER_1.has(event) || RUNNING_TIER_2.has(event);
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
