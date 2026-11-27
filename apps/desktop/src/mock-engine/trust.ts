/**
 * Hooks and project trust in the mock engine, answered as the real engine answers them (Phase 4:
 * `project.inspect`, `project.trust`, `hooks.list`, `hooks.setEnabled`, and `hook.ran`).
 *
 * The setup it pretends to read:
 * - `~/code/notes-cli/.claude/settings.json` (Claude Code's project file): a PreToolUse hook on
 *   Bash and a UserPromptSubmit hook, both commands, and a Stop hook of the `prompt` type, which
 *   dawg does not run yet.
 * - `~/.dawg/settings.json` (the person's own): a Notification hook, which needs no consent.
 *
 * The project's code starts approved, as if the person said yes on an earlier day: a dialog that
 * opened by itself on a recorded session would stand in front of every walk through the mock app.
 * Taking consent back (`project.trust` with `approved: false`) makes it wait again.
 *
 * No Node APIs (the mock runs in a browser tab too), so the "hash" is a plain string hash.
 */
import type {
  CodeApproval,
  CompatItem,
  CompatSource,
  EventPayloadInput,
  HookInfo,
} from "@dawg/protocol";
import { ErrorCodes, RpcError } from "@dawg/protocol";

interface MockHook {
  event: string;
  matcher: string | null;
  type: string;
  command: string;
  timeout: number | null;
  source: CompatSource;
  /** Needs the person's consent (the project's files, or Claude Code's own user files). */
  consent: boolean;
  /** Runs in this version (a command handler for a tier 1 event). */
  supported: boolean;
}

/** "PreToolUse on Bash: ./scripts/check-command.sh", as the engine names report items. */
function itemName(hook: MockHook): string {
  const matcher = hook.matcher?.trim() ?? "";
  const on = matcher === "" || matcher === "*" ? "" : ` on ${matcher}`;
  return `${hook.event}${on}: ${hook.command}`;
}

/** FNV-1a over the text: stable, and enough to tell definitions apart in a mock. */
function hashOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function idOf(hook: MockHook): string {
  return `hook:${hashOf(JSON.stringify([hook.source.path, hook.event, hook.matcher, hook.command]))}`;
}

const NOT_SUPPORTED_PROMPT =
  "Prompt hooks ask a model to decide; dawg runs command hooks only in this version.";
const PROJECT_CODE = "Runs a command from the project's files.";

export class MockTrust {
  readonly #homeDir: string;
  /** Projects whose code the person approved, with the hash they approved. */
  readonly #approved = new Map<string, string>();
  /** Hooks the person turned off, by id. */
  readonly #off = new Set<string>();

  constructor(homeDir: string) {
    this.#homeDir = homeDir.replace(/\/+$/, "");
    const notes = this.#notesCli();
    const approval = this.#approval(notes);
    if (approval !== null) this.#approved.set(notes, approval.hash);
  }

  #notesCli(): string {
    return `${this.#homeDir}/code/notes-cli`;
  }

  /** Every hook that applies to a project (or only the person's own, for null), in file order. */
  #hooks(projectDir: string | null): MockHook[] {
    const own: MockHook = {
      event: "Notification",
      matcher: "permission_prompt",
      type: "command",
      command: `osascript -e 'display notification "dawg needs you"'`,
      timeout: null,
      source: { path: `${this.#homeDir}/.dawg/settings.json`, origin: "dawg", scope: "user" },
      consent: false,
      supported: true,
    };
    if (projectDir === null || projectDir.replace(/\/+$/, "") !== this.#notesCli()) return [own];
    const source: CompatSource = {
      path: `${this.#notesCli()}/.claude/settings.json`,
      origin: "claude",
      scope: "project",
    };
    return [
      {
        event: "PreToolUse",
        matcher: "Bash",
        type: "command",
        command: "./scripts/check-command.sh",
        timeout: 10,
        source,
        consent: true,
        supported: true,
      },
      {
        event: "UserPromptSubmit",
        matcher: null,
        type: "command",
        command: "./scripts/add-ticket-context.sh",
        timeout: null,
        source,
        consent: true,
        supported: true,
      },
      {
        event: "Stop",
        matcher: null,
        type: "prompt",
        command: "Check that the tests pass before stopping.",
        timeout: null,
        source,
        consent: true,
        supported: false,
      },
      own,
    ];
  }

  #approval(projectDir: string): CodeApproval | null {
    const needing = this.#hooks(projectDir).filter((hook) => hook.consent);
    if (needing.length === 0) return null;
    const hash = `mock:${hashOf(JSON.stringify(needing))}`;
    const approved = this.#approved.get(projectDir) === hash;
    return {
      hash,
      approved,
      items: needing.map((hook) => this.#item(hook, approved)),
    };
  }

  #item(hook: MockHook, approved: boolean): CompatItem {
    const notes: string[] = [];
    if (!hook.supported) notes.push(NOT_SUPPORTED_PROMPT);
    if (hook.consent) notes.push(PROJECT_CODE);
    return {
      kind: "hook",
      name: itemName(hook),
      source: hook.source,
      status: !hook.supported
        ? "not-supported"
        : hook.consent && !approved
          ? "needs-approval"
          : "loaded",
      notes,
    };
  }

  /** `project.inspect`: the hooks found, and what needs consent. */
  inspect(projectDir: string | null) {
    const approval = projectDir === null ? null : this.#approval(projectDir);
    const approved = approval?.approved ?? true;
    return {
      projectDir,
      items: this.#hooks(projectDir).map((hook) => this.#item(hook, approved)),
      approval,
    };
  }

  /** `project.trust`: refuses a hash that is not what the project holds now. */
  trust(projectDir: string, hash: string, approved: boolean): { approved: boolean } {
    const approval = this.#approval(projectDir);
    if (approval === null || approval.hash !== hash) {
      throw new RpcError(
        ErrorCodes.InvalidState,
        "The project's hooks changed since they were listed; review them again.",
      );
    }
    if (approved) this.#approved.set(projectDir, hash);
    else this.#approved.delete(projectDir);
    return { approved };
  }

  /** `hooks.list`. */
  list(projectDir: string | null): {
    projectDir: string | null;
    hooks: HookInfo[];
    disabledBy: string | null;
  } {
    const approved = projectDir === null ? true : (this.#approval(projectDir)?.approved ?? true);
    const hooks = this.#hooks(projectDir).map((hook): HookInfo => {
      const item = this.#item(hook, approved);
      return {
        id: idOf(hook),
        event: hook.event,
        matcher: hook.matcher,
        type: hook.type,
        command: hook.command,
        timeout: hook.timeout,
        source: hook.source,
        status: item.status,
        notes: item.notes,
        enabled: !this.#off.has(idOf(hook)),
      };
    });
    return { projectDir, hooks, disabledBy: null };
  }

  /** `hooks.setEnabled`. */
  setEnabled(projectDir: string | null, id: string, enabled: boolean): { enabled: boolean } {
    if (!this.#hooks(projectDir).some((hook) => idOf(hook) === id)) {
      throw new RpcError(ErrorCodes.InvalidParams, `No hook with the id ${id} applies here.`);
    }
    if (enabled) this.#off.delete(id);
    else this.#off.add(id);
    return { enabled };
  }

  /**
   * The `hook.ran` a prompt sent in a session of this project gets from its UserPromptSubmit
   * hook (before the turn starts, so with no turn), or null when none would run: not approved,
   * turned off, or no such hook.
   */
  promptHookRan(
    projectDir: string,
    durationMs: number,
  ): Omit<EventPayloadInput<"hook.ran">, "sessionId" | "seq" | "time"> | null {
    const hook = this.#hooks(projectDir).find((h) => h.event === "UserPromptSubmit");
    if (hook === undefined || this.#off.has(idOf(hook))) return null;
    if (hook.consent && !(this.#approval(projectDir)?.approved ?? false)) return null;
    return {
      turnId: null,
      toolCallId: null,
      hook: {
        event: hook.event,
        matcher: hook.matcher,
        type: hook.type,
        command: hook.command,
        source: hook.source,
      },
      outcome: "success",
      exitCode: 0,
      durationMs,
      decision: null,
      message: null,
    };
  }
}
