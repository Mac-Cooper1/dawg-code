/**
 * Added (Phase 4, sandbox): how the engine names a host a project's settings open to sandboxed
 * commands in its approval list ("Network access to example.com (sandbox)"), so the trust dialog
 * and Settings → Project setup can call it what it is.
 */
import type { CompatItem } from "@dawg/protocol";

const HOST_NAME = /^Network access to (.+) \(sandbox\)$/;

/** Whether an approval item is a sandbox host rather than code. */
export function isSandboxHost(item: Pick<CompatItem, "kind" | "name">): boolean {
  return item.kind === "other" && HOST_NAME.test(item.name);
}
