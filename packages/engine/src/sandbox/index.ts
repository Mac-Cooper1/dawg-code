/**
 * The sandbox for shell commands (Phase 4 spec, "Sandbox"): the runtime every engine shares, one
 * session's view of it, and the pieces the Bash tool and the permission engine use.
 */
export { isExcludedCommand } from "./excluded.ts";
export { rulesForSandbox, sandboxDomainForRule, sandboxPathsForRule } from "./rules.ts";
export {
  acceptedDomains,
  type SandboxAvailability,
  SandboxHost,
  type SandboxSwitches,
  type WrappedCommand,
  type WrapRequest,
} from "./runtime.ts";
export {
  displayForPlan,
  getSessionSandbox,
  protectedWriteEntries,
  refusedInOutput,
  SANDBOX_STATE_KEY,
  type SandboxOutcome,
  type SandboxPlan,
  SessionSandbox,
  type SessionSandboxOptions,
} from "./session.ts";
export { describeViolation, describeViolations, ignoredViolation } from "./violations.ts";
