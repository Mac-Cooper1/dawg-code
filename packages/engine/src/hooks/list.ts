/**
 * Settings → Hooks (`hooks.list`, `hooks.setEnabled`): every hook that applies to a project or to
 * the person's own files, what dawg does with it, whether it waits for consent, and the person's
 * switch for it. The switch is kept by the trust store in dawg's data folder, never in a settings
 * file: Claude Code's files are read-only to dawg, and a project's shared files are not the place
 * for one person's choice.
 */
import path from "node:path";
import { hookItem, loadHooks } from "@dawg/compat";
import type { HookInfo } from "@dawg/protocol";
import { RuntimeError } from "../runtime/errors.ts";
import { hookId } from "../trust/definitions.ts";
import type { CodeTrust } from "../trust/index.ts";

export interface HookList {
  projectDir: string | null;
  hooks: HookInfo[];
  disabledBy: string | null;
}

export async function listHooks(
  trust: CodeTrust,
  options: { projectDir: string | null; homeDir: string },
): Promise<HookList> {
  const projectDir = options.projectDir === null ? null : path.resolve(options.projectDir);
  const loaded = await loadHooks({ projectDir, homeDir: options.homeDir });
  const [approval, off] = await Promise.all([
    trust.approval(projectDir),
    trust.switches?.off(projectDir) ?? Promise.resolve(new Set<string>()),
  ]);
  // The approval names each hook as the report does, with its file.
  const waiting = new Set(
    (approval?.items ?? [])
      .filter((item) => item.kind === "hook" && item.status === "needs-approval")
      .map((item) => `${item.source.path}\n${item.name}`),
  );
  const hooks: HookInfo[] = [];
  for (const hook of loaded.hooks) {
    const item = await hookItem(hook, { projectDir, homeDir: options.homeDir });
    const id = hookId(hook);
    let status = item.status;
    const notes = [...item.notes];
    if (waiting.has(`${hook.source.path}\n${item.name}`) && status !== "not-supported") {
      status = "needs-approval";
      notes.unshift(
        hook.source.scope === "user"
          ? "Claude Code's settings in your home folder run commands written for another app, so it waits for your approval."
          : "It comes from the project's files, so it waits for your approval.",
      );
    }
    hooks.push({
      id,
      event: hook.event,
      matcher: hook.matcher,
      type: hook.handler.type,
      command: hook.handler.target,
      timeout: hook.handler.timeout,
      source: hook.source,
      status,
      notes,
      enabled: !off.has(id),
    });
  }
  return { projectDir, hooks, disabledBy: loaded.disabledBy };
}

/** Turns one hook off or back on (`hooks.setEnabled`). InvalidParams for an unknown id. */
export async function setHookEnabled(
  trust: CodeTrust,
  options: { projectDir: string | null; homeDir: string; id: string; enabled: boolean },
): Promise<boolean> {
  const projectDir = options.projectDir === null ? null : path.resolve(options.projectDir);
  const loaded = await loadHooks({ projectDir, homeDir: options.homeDir });
  const hook = loaded.hooks.find((h) => hookId(h) === options.id);
  if (hook === undefined) {
    throw new RuntimeError(
      "InvalidParams",
      "That hook is no longer in the settings files; list the hooks again.",
    );
  }
  if (trust.switches === undefined) {
    throw new RuntimeError("InvalidState", "Hooks cannot be switched off in this build.");
  }
  await trust.switches.set({
    projectDir,
    id: options.id,
    // The person's own hooks apply to every project, so their switch does too.
    scope: hook.source.scope === "user" ? "user" : "project",
    enabled: options.enabled,
  });
  return options.enabled;
}
