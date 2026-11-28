/**
 * What the sandbox stopped a command from doing, as a person reads it. The runtime records lines
 * from two places: the system's sandbox log on macOS ("bash(123) deny(1) file-write-create /x")
 * and its proxy ("deny network-outbound example.com:443 (host is not on the allow list)").
 */

/** Lookups of system services that every program makes and the sandbox refuses: not news. */
const NOISE = /\bdeny\(\d+\)\s+(mach-lookup|sysctl-|iokit-|ipc-|user-preference|system-)/;

const SEATBELT = /^\S+\(\d+\)\s+deny\(\d+\)\s+(\S+)\s*(.*)$/;
const PROXY = /^deny network-outbound (\S+) \((.+)\)$/;

/**
 * One line for a violation the runtime recorded, or null for one not worth showing. Lines that
 * repeat (a program retrying) come out the same, so callers can drop duplicates.
 */
export function describeViolation(line: string): string | null {
  const proxied = PROXY.exec(line.trim());
  if (proxied) {
    const [, target, why] = proxied;
    const reason =
      why === "host is not on the allow list" ? "not on the allowed list" : (why ?? "refused");
    return `Connecting to ${target} (${reason})`;
  }
  if (NOISE.test(line)) return null;
  const m = SEATBELT.exec(line.trim());
  if (!m) return null;
  const [, operation = "", rest = ""] = m;
  const target = rest.trim();
  if (operation.startsWith("file-write")) return `Writing ${target}`;
  if (operation.startsWith("file-read")) return `Reading ${target}`;
  if (operation.startsWith("network-outbound") || operation.startsWith("network-bind")) {
    const port = /^remote:\S*:(\d+)$/.exec(target)?.[1];
    if (port !== undefined) return `Connecting to port ${port} directly, not through the proxy`;
    if (target.startsWith("/")) return `Connecting to the socket ${target}`;
    return `Connecting to ${target}`;
  }
  return null;
}

/**
 * Whether `sandbox.ignoreViolations` hides a violation of this command, as documented: the key
 * is "*" or text found in the command, and a value is text found in the violation.
 */
export function ignoredViolation(
  line: string,
  command: string,
  ignore: Readonly<Record<string, readonly string[]>>,
): boolean {
  for (const [pattern, values] of Object.entries(ignore)) {
    if (pattern !== "*" && !command.includes(pattern)) continue;
    if (values.some((value) => value !== "" && line.includes(value))) return true;
  }
  return false;
}

/** The violations worth showing for one command, described, without duplicates. */
export function describeViolations(
  lines: readonly string[],
  command: string,
  ignore: Readonly<Record<string, readonly string[]>>,
): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (ignoredViolation(line, command, ignore)) continue;
    const described = describeViolation(line);
    if (described !== null && !out.includes(described)) out.push(described);
  }
  return out;
}

/** Text a command prints when the system refused it something, as macOS and Linux word it. */
export const PERMISSION_ERROR = /operation not permitted|permission denied|read-only file system/i;
