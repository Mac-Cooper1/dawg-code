/**
 * A handler's `if` field: "Permission rule syntax to filter when this hook runs, such as
 * `Bash(git *)` or `Edit(*.ts)`" (code.claude.com/docs/en/hooks, the `if` field). It is matched
 * the way the permission engine matches a deny rule, so `Bash(rm *)` finds `rm` inside a compound
 * command too, and a path rule reads paths as permission rules do.
 */
import type {
  PermissionQuery,
  PermissionReason,
  PermissionState,
} from "../contracts/permissions.ts";
import { decidePermission } from "../permissions/index.ts";

function ruleDecided(reason: PermissionReason, rule: string): boolean {
  if (reason.type === "rule") return reason.list === "deny" && reason.rule.rule === rule;
  if (reason.type === "command_part") return ruleDecided(reason.reason, rule);
  return false;
}

/**
 * Whether one permission rule matches a tool call. A command that cannot be analysed counts as a
 * match: "If Claude Code can't split the input, the hook runs regardless."
 */
export function ifRuleMatches(
  rule: string,
  query: PermissionQuery,
  state: PermissionState,
): boolean {
  const decision = decidePermission(query, {
    ...state,
    // The rule alone decides; the mode allows everything else.
    mode: "bypassPermissions",
    rules: {
      allow: [],
      ask: [],
      deny: [{ rule, from: { source: "session", origin: null, path: null } }],
    },
  });
  if (decision.reason.type === "unparseable_command") return true;
  return decision.behavior === "deny" && ruleDecided(decision.reason, rule);
}
