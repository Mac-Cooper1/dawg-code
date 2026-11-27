/**
 * Consent for the code a setup supplies (Phase 4 spec, principle 3). Hooks and MCP servers
 * defined in a project's files run arbitrary commands, so they run only after the person has seen
 * them and said yes; the same goes for those in Claude Code's own user files, written for another
 * app. Consent is kept per project under a hash of the definitions, so any change asks again. The
 * person's own dawg files (`~/.dawg`) need no consent.
 *
 * This file is the contract the hooks runner, the host's `project.inspect` and `project.trust`,
 * and (later) MCP rely on. The real store is `createTrustStore` (store.ts), wired where an engine
 * is made for real use (the desktop engine host, the CLI); `NO_CODE_TRUST` is the default, which
 * tests keep unless they test trust.
 */
import type { CodeApproval, CompatSource } from "@dawg/protocol";

export interface CodeTrust {
  /**
   * What in this setup needs consent, and whether it has it, for `project.inspect`. Null when
   * nothing needs consent. With `projectDir` null, only the person's own files count.
   */
  approval(projectDir: string | null): Promise<CodeApproval | null>;
  /**
   * Records the person's decision for the definitions with this hash, and answers whether they
   * may run now. Rejects when the hash no longer matches what is on disk: consent never covers
   * code nobody saw.
   */
  decide(projectDir: string, hash: string, approved: boolean): Promise<boolean>;
  /** Whether code defined in this file may run now, for a session in `projectDir`. */
  allows(source: CompatSource, projectDir: string | null): Promise<boolean>;
  /**
   * The person's switches for single hooks (Settings → Hooks), kept with consent. Absent: every
   * hook is on and none can be turned off.
   */
  switches?: HookSwitches;
}

/** The person's on/off switch for single hooks, by `hookId` (definitions.ts). */
export interface HookSwitches {
  /** Ids of the hooks turned off that apply to a session in `projectDir`. */
  off(projectDir: string | null): Promise<ReadonlySet<string>>;
  /**
   * Turns one hook off or back on: for every project when it is one of the person's own hooks
   * (scope "user"), else for this project only.
   */
  set(input: {
    projectDir: string | null;
    id: string;
    scope: "user" | "project";
    enabled: boolean;
  }): Promise<void>;
}

/**
 * Until the trust store lands: nothing is offered for consent, and only the person's own dawg
 * files may run code.
 */
export const NO_CODE_TRUST: CodeTrust = {
  approval: async () => null,
  decide: async () => {
    throw new Error("Approving a project's code is not in this build yet.");
  },
  allows: async (source) => source.scope === "user" && source.origin === "dawg",
};

export {
  approvalHash,
  canonicalJson,
  collectDefinitions,
  definitionsIn,
  fileLabel,
  hookId,
  needsConsent,
  sandboxHostId,
  sandboxHostName,
  sandboxHostsIn,
  type TrustDefinition,
} from "./definitions.ts";
export { withApproval } from "./report.ts";
export {
  createTrustStore,
  TRUST_FILE,
  TrustError,
  TrustStore,
  type TrustStoreOptions,
} from "./store.ts";
