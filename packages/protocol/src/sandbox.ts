/**
 * The sandbox (Phase 4, "Sandbox"): how a shell command runs with respect to the sandbox that
 * keeps its writes to the working directories and temp and its network to listed hosts. Shown on
 * the transcript's command cards (`CommandDisplay.sandbox`) and on permission requests for
 * commands that would run outside it (`PermissionRequest.sandbox`).
 *
 * Self-contained (zod only), so common.ts can use it without a cycle.
 */
import { z } from "zod";

/** Why a command runs outside the sandbox while the sandbox is on. */
export const SandboxOutsideReasonSchema = z.enum([
  /** It matches `sandbox.excludedCommands`: a command named as one that cannot work inside. */
  "excluded",
  /** The model asked to run it again outside, after the sandbox got in its way. */
  "retry",
  /** The sandbox cannot run on this system, and `sandbox.failIfUnavailable` is off. */
  "unavailable",
]);
export type SandboxOutsideReason = z.infer<typeof SandboxOutsideReasonSchema>;

export const CommandSandboxSchema = z.object({
  /** "inside": the command runs in the sandbox; "outside": the sandbox is on but it runs without it. */
  placement: z.enum(["inside", "outside"]),
  /** Why it runs outside; null inside. */
  reason: SandboxOutsideReasonSchema.nullable(),
  /**
   * What the sandbox stopped while the command ran, one short line each, as a person reads it:
   * "Writing /etc/hosts", "Connecting to example.com:443". Empty when nothing was seen, and
   * always empty on a permission request (nothing has run yet).
   */
  blocked: z.array(z.string()).default([]),
});
export type CommandSandbox = z.infer<typeof CommandSandboxSchema>;
