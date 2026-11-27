/**
 * One session's sandbox: where each of its shell commands runs, and what the sandbox around a
 * command allows, from the session's settings, working directories and permission rules.
 *
 * The session keeps it in its state bag (`SANDBOX_STATE_KEY`), so the Bash tool finds it both
 * when a call is judged (synchronously, for the permission engine) and when it runs. Settings
 * are read through a getter, so an edit to the settings files applies from the next turn, like
 * the rest of them.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { defaultSandboxSettings, type PermissionRule, type SandboxSettings } from "@dawg/compat";
import type { CommandSandbox, CompatSource } from "@dawg/protocol";
import type { CommandSandboxPlan } from "../contracts/permissions.ts";
import type { SessionStateBag } from "../contracts/tools.ts";
import { isExcludedCommand } from "./excluded.ts";
import { rulesForSandbox } from "./rules.ts";
import type { SandboxHost, WrappedCommand } from "./runtime.ts";
import { describeViolations } from "./violations.ts";

export const SANDBOX_STATE_KEY = "sandbox.session";

export interface SessionSandboxOptions {
  host: SandboxHost;
  /** The session's merged settings' `sandbox`, as they are now. */
  settings(): SandboxSettings | undefined;
  /** The session's permission rules, as they are now. */
  rules(): { allow: readonly PermissionRule[]; deny: readonly PermissionRule[] };
  homeDir: string;
  /**
   * Whether the person has approved the code and hosts of one of the project's files (the
   * engine's trust store, `CodeTrust.allows`). Hosts a project's files list reach the sandbox's
   * list only when it says yes. Absent: none of them do.
   */
  allows?(source: CompatSource): Promise<boolean>;
}

/** The hosts a command may reach, and the project's hosts still waiting for approval. */
export interface SandboxHosts {
  allowed: string[];
  pending: string[];
}

/** Where a command runs, or why it does not run at all. Null from `plan` when the sandbox is off. */
export type SandboxPlan = CommandSandboxPlan | { run: "refused"; why: string };

/** File names that can make code run later, kept read-only in every working directory. */
const PROTECTED_FILES = [
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".profile",
  ".gitconfig",
  ".gitmodules",
  ".ripgreprc",
  ".mcp.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".dawg/settings.json",
  ".dawg/settings.local.json",
  ".dawg/mcp.json",
  ".git/config",
];
/** Folders that hold configuration that runs code, kept read-only in every working directory. */
const PROTECTED_DIRS = [
  ".vscode",
  ".idea",
  ".git/hooks",
  ".claude/commands",
  ".claude/agents",
  ".claude/skills",
  ".claude/hooks",
  ".dawg/commands",
  ".dawg/agents",
  ".dawg/skills",
  ".dawg/hooks",
];

/**
 * The write denies for one working directory: each protected name in it, and below it at any
 * depth. The runtime's own list is anchored at the process's directory, not the session's, so
 * dawg lists them for every working directory itself.
 */
export function protectedWriteEntries(dir: string): (string | { path: string; literal: true })[] {
  const out: (string | { path: string; literal: true })[] = [];
  for (const name of PROTECTED_FILES) {
    out.push({ path: path.join(dir, name), literal: true });
    out.push(path.join(dir, "**", name));
  }
  for (const name of PROTECTED_DIRS) {
    out.push({ path: path.join(dir, name), literal: true });
    out.push(path.join(dir, "**", name, "**"));
  }
  return out;
}

/** What the runtime leaves writable unasked (its `getDefaultWritePaths`), apart from stdio. */
function runtimeConvenienceWrites(): string[] {
  return [
    "/tmp/claude",
    "/private/tmp/claude",
    path.join(homedir(), ".npm", "_logs"),
    path.join(homedir(), ".claude", "debug"),
  ];
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** What a finished sandboxed command reports. */
export interface SandboxOutcome {
  display: CommandSandbox;
  /** Sentences for the model, after the output. Empty when there is nothing to say. */
  notes: string[];
}

export class SessionSandbox {
  readonly #options: SessionSandboxOptions;
  /** The hosts each running command was given, for what its result says. */
  readonly #hostsFor = new Map<string, SandboxHosts>();

  constructor(options: SessionSandboxOptions) {
    this.#options = options;
  }

  /** The settings in force, or the documented defaults (off). */
  settings(): SandboxSettings {
    return this.#options.settings() ?? defaultSandboxSettings();
  }

  get host(): SandboxHost {
    return this.#options.host;
  }

  /**
   * Where a command will run. Synchronous and cheap, for the permission check; `execute` asks
   * again and gets the same answer for the same settings.
   */
  plan(command: string, retryOutside: boolean, cwd: string): SandboxPlan | null {
    const s = this.settings();
    if (!s.enabled) return null;
    const availability = this.#options.host.availability();
    if (!availability.available) {
      if (s.failIfUnavailable) {
        return {
          run: "refused",
          why: `${availability.reason ?? "The sandbox cannot run here."} sandbox.failIfUnavailable is on, so commands do not run without it.`,
        };
      }
      return { run: "outside", why: "unavailable" };
    }
    if (retryOutside && s.allowUnsandboxedCommands) return { run: "outside", why: "retry" };
    if (isExcludedCommand(command, s.excludedCommands, { cwd, homeDir: this.#options.homeDir })) {
      return { run: "outside", why: "excluded" };
    }
    return { run: "inside", autoAllow: s.autoAllowBashIfSandboxed };
  }

  /**
   * Wraps a script for the sandbox, starting the runtime on first use. The caller runs the
   * returned command line with bash and calls `release` when it ends.
   */
  async wrap(input: {
    script: string;
    commandText: string;
    shell: string;
    cwd: string;
    workingDirectories: readonly string[];
    signal?: AbortSignal;
  }): Promise<WrappedCommand> {
    const host = this.#options.host;
    await host.start();
    const s = this.settings();
    const tempDir = host.tempDir;
    const workingDirectories = [...new Set(input.workingDirectories.map(realOr))];
    const fromRules = rulesForSandbox(this.#options.rules(), {
      cwd: input.workingDirectories[0] ?? input.cwd,
      homeDir: this.#options.homeDir,
    });
    const denyWrite: (string | { path: string; literal: true })[] = [
      ...s.filesystem.denyWrite,
      ...fromRules.denyWrite,
      ...workingDirectories.flatMap(protectedWriteEntries),
    ];
    if (host.installDir !== null) denyWrite.push({ path: host.installDir, literal: true });
    // The runtime keeps a few places writable for its own convenience: its default temp folder
    // (dawg gives commands one of its own) and two log folders in the home folder. Writes go to
    // the working directories and temp only, so they are closed again.
    for (const place of runtimeConvenienceWrites()) denyWrite.push({ path: place, literal: true });
    // Every script starts by pointing temp files at the sandbox's own temp folder.
    const script =
      tempDir === null ? input.script : `export TMPDIR=${shellQuote(tempDir)}; ${input.script}`;
    const hosts = await this.hosts();
    const wrapped = await host.wrap({
      script,
      commandText: input.commandText,
      shell: input.shell,
      allowWrite: [
        ...workingDirectories,
        ...(tempDir === null ? [] : [tempDir]),
        ...s.filesystem.allowWrite,
      ],
      denyWrite,
      denyRead: [...s.filesystem.denyRead, ...fromRules.denyRead],
      allowRead: s.filesystem.allowRead,
      filesystemDisabled: s.filesystem.disabled,
      allowedDomains: hosts.allowed,
      deniedDomains: [...s.network.deniedDomains, ...fromRules.deniedDomains],
      credentials: s.credentials,
      switches: {
        allowLocalBinding: s.network.allowLocalBinding,
        allowUnixSockets: s.network.allowUnixSockets,
        allowAllUnixSockets: s.network.allowAllUnixSockets,
        allowMachLookup: s.network.allowMachLookup,
        enableWeakerNetworkIsolation: s.enableWeakerNetworkIsolation,
        enableWeakerNestedSandbox: s.enableWeakerNestedSandbox,
        allowAppleEvents: s.allowAppleEvents,
        allowNestedUserNamespaces: s.allowNestedUserNamespaces,
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    // Read by `outcome` when the command ends; background commands never are, so few are kept.
    this.#hostsFor.set(wrapped.commandId, hosts);
    if (this.#hostsFor.size > 64) this.#hostsFor.delete(this.#hostsFor.keys().next().value ?? "");
    return wrapped;
  }

  /**
   * The hosts sandboxed commands of this session may reach now. Hosts the person's own settings
   * and rules list always count; those a project's files list (shared or personal, `.claude` or
   * `.dawg`, in `sandbox.network.allowedDomains` or as `WebFetch(domain:…)` rules) count only
   * once the person has approved the project's setup, like its hooks (Phase 4, principle 3).
   */
  async hosts(): Promise<SandboxHosts> {
    const s = this.settings();
    const fromRules = rulesForSandbox(this.#options.rules(), {
      cwd: "/",
      homeDir: this.#options.homeDir,
    });
    const personal = new Set<string>();
    const byFile = new Map<string, { source: CompatSource; domains: string[] }>();
    const fromProject = (path: string, scope: "local" | "project", origin: "dawg" | "claude") => {
      let entry = byFile.get(path);
      if (entry === undefined) {
        entry = { source: { path, scope, origin }, domains: [] };
        byFile.set(path, entry);
      }
      return entry;
    };
    const listed = new Set<string>();
    for (const from of s.network.allowedDomainsFrom) {
      for (const domain of from.domains) listed.add(domain);
      if (from.source === "user") for (const domain of from.domains) personal.add(domain);
      else fromProject(from.path, from.source, from.origin).domains.push(...from.domains);
    }
    // Hosts whose file is not known (the command line, settings built by hand) are the person's.
    for (const domain of s.network.allowedDomains) if (!listed.has(domain)) personal.add(domain);
    for (const { domain, from } of fromRules.allowedDomainsFrom) {
      const scope = from.source;
      if ((scope === "local" || scope === "project") && from.path !== null) {
        fromProject(from.path, scope, from.origin ?? "dawg").domains.push(domain);
      } else if (scope !== "local" && scope !== "project") {
        personal.add(domain);
      }
    }
    const allowed = new Set(personal);
    const pending = new Set<string>();
    for (const { source, domains } of byFile.values()) {
      const approved =
        this.#options.allows === undefined
          ? false
          : await this.#options.allows(source).catch(() => false);
      for (const domain of domains) (approved ? allowed : pending).add(domain);
    }
    for (const domain of allowed) pending.delete(domain);
    return { allowed: [...allowed], pending: [...pending] };
  }

  /**
   * What to tell the model and show the person about a sandboxed command that has ended: what
   * the sandbox stopped, and what the model can do about it.
   */
  outcome(input: {
    commandId: string;
    commandText: string;
    failed: boolean;
    output: string;
  }): SandboxOutcome {
    const s = this.settings();
    const hosts = this.#hostsFor.get(input.commandId) ?? { allowed: [], pending: [] };
    this.#hostsFor.delete(input.commandId);
    let blocked = describeViolations(
      this.#options.host.violations(input.commandId),
      input.commandText,
      s.ignoreViolations,
    );
    // The system's log can miss a refusal (it is busy, or was not listening yet); the paths the
    // command itself said it was refused stand in for it.
    if (blocked.length === 0) blocked = refusedInOutput(input.output);
    const display: CommandSandbox = { placement: "inside", reason: null, blocked };
    const notes: string[] = [];
    const permissionError = /operation not permitted|permission denied|read-only file system/i;
    if (blocked.length === 0 && !(input.failed && permissionError.test(input.output))) {
      return { display, notes };
    }
    const domains = hosts.allowed;
    let limits = `Sandboxed commands may write only in the working directories and $TMPDIR, and reach only ${
      domains.length === 0 ? "no hosts at all" : `these hosts: ${domains.join(", ")}`
    }.`;
    if (hosts.pending.length > 0) {
      limits += ` The project's settings also list ${hosts.pending.join(", ")}, which the person has not approved yet; ask them to review the project's setup if the command needs ${hosts.pending.length === 1 ? "it" : "them"}.`;
    }
    const retry = s.allowUnsandboxedCommands
      ? "If the command really needs this, run it again with dangerouslyDisableSandbox set to true: it then runs outside the sandbox, and the person is asked first."
      : "Running commands outside the sandbox is turned off here, so find another way, or explain to the person what is needed.";
    notes.push(
      blocked.length > 0
        ? `The sandbox blocked this command: ${blocked.join("; ")}. ${limits} ${retry}`
        : `This command ran in the sandbox, which may be why it was refused permission. ${limits} ${retry}`,
    );
    return { display, notes };
  }
}

/** "Not permitted: /etc/hosts" for each path a command printed "Operation not permitted" for. */
export function refusedInOutput(output: string): string[] {
  const out: string[] = [];
  for (const m of output.matchAll(
    /(\/[^\n:]*): (?:Operation not permitted|Read-only file system)/g,
  )) {
    const line = `Not permitted: ${m[1]}`;
    if (!out.includes(line)) out.push(line);
    if (out.length >= 10) break;
  }
  return out;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The session's sandbox, or null where none was set up (a session-less test, a subagent). */
export function getSessionSandbox(state: SessionStateBag): SessionSandbox | null {
  return state.get<SessionSandbox | null>(SANDBOX_STATE_KEY, () => null);
}

/** What a command's display says about the sandbox, for a plan made before it ran. */
export function displayForPlan(plan: SandboxPlan | null): CommandSandbox | undefined {
  if (plan === null || plan.run === "refused") return undefined;
  if (plan.run === "inside") return { placement: "inside", reason: null, blocked: [] };
  return { placement: "outside", reason: plan.why, blocked: [] };
}
