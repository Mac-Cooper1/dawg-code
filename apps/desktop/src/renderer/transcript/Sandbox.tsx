/**
 * The sandbox on shell commands (Phase 4): a mark in a command card's header (in the sandbox,
 * outside it, or what it blocked), what it blocked in the card's body, and a line on a
 * permission card for a command that would run outside it.
 */
import type { CommandSandbox, SandboxOutsideReason } from "@dawg/protocol";
import { Icon } from "../ui/index.ts";
import styles from "./Sandbox.module.css";

function why(reason: SandboxOutsideReason | null): string {
  switch (reason) {
    case "retry":
      return "the sandbox blocked it, so it is being tried again without the sandbox";
    case "excluded":
      return "it is one of the commands the settings exclude from the sandbox";
    case "unavailable":
      return "the sandbox cannot run on this system";
    default:
      return "the sandbox does not cover it";
  }
}

/** The mark's words, which its accessible name and the card's include. */
export function sandboxMarkText(sandbox: CommandSandbox): string {
  if (sandbox.placement === "outside") return "outside the sandbox";
  if (sandbox.blocked.length > 0) {
    return `sandbox blocked ${sandbox.blocked.length === 1 ? "1 action" : `${sandbox.blocked.length} actions`}`;
  }
  return "sandboxed";
}

/** A command card's header mark. */
export function SandboxMark({ sandbox }: { sandbox: CommandSandbox }) {
  const tone =
    sandbox.placement === "outside"
      ? styles.outside
      : sandbox.blocked.length > 0
        ? styles.blocked
        : styles.inside;
  return (
    <span className={`${styles.mark} ${tone}`} data-placement={sandbox.placement}>
      <Icon name="shield" size={12} className={styles.icon} />
      {sandboxMarkText(sandbox)}
    </span>
  );
}

/** In a command card's body: what the sandbox blocked, or why the command ran outside it. */
export function SandboxDetails({ sandbox }: { sandbox: CommandSandbox }) {
  if (sandbox.placement === "outside") {
    return (
      <p className={`${styles.details} ${styles.outsideText}`}>
        Ran outside the sandbox: {why(sandbox.reason)}.
      </p>
    );
  }
  if (sandbox.blocked.length === 0) return null;
  return (
    <section className={styles.details} aria-label="Blocked by the sandbox">
      <p className={styles.blockedHeading}>Blocked by the sandbox</p>
      <ul className={styles.list}>
        {sandbox.blocked.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className={styles.hint}>
        Sandboxed commands write only in the working folders and temp, and reach only the allowed
        hosts. dawg asks you before running a command outside the sandbox.
      </p>
    </section>
  );
}

/** On a permission card for a shell command: where it would run. */
export function SandboxPermissionLine({ sandbox }: { sandbox: CommandSandbox | undefined }) {
  if (sandbox === undefined) return null;
  if (sandbox.placement === "inside") {
    return (
      <p className={`${styles.line} ${styles.inside}`}>
        <Icon name="shield" size={12} className={styles.icon} />
        Runs in the sandbox: writes stay in the working folders and temp.
      </p>
    );
  }
  return (
    <p className={`${styles.line} ${styles.outsideText}`}>
      <Icon name="shield" size={12} className={styles.icon} />
      Runs outside the sandbox, with full access: {why(sandbox.reason)}.
    </p>
  );
}
