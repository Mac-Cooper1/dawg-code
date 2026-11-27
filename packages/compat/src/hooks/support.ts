/**
 * What dawg does with each hook handler, for the compatibility report and Settings → Hooks:
 * whether it runs, and every documented field or event it does not honour yet, named in a note
 * (spec, principle 2: unsupported fields are reported, not dropped).
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { expandHome } from "../internal/paths.ts";
import {
  EVENTS_WITH_IF,
  EVENTS_WITHOUT_MATCHER,
  eventTier,
  HANDLER_TYPES,
  isRunningEvent,
} from "./events.ts";
import type { HookDefinition } from "./read.ts";

export interface HookSupport {
  status: "loaded" | "partly-supported" | "not-supported";
  notes: string[];
}

/** The spec's "Known gap" (Phase 4, Hooks), as the report words it. */
export const TRANSCRIPT_GAP_NOTE =
  "Reads the session transcript (transcript_path). dawg keeps transcripts in its own format, so that part of the hook will not work unchanged.";

/** Longest command shown in an item's name. */
const MAX_NAME_COMMAND = 100;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** True when the matcher matches everything: absent, empty or "*". */
export function matchesEverything(matcher: string | null): boolean {
  return matcher === null || matcher.trim() === "" || matcher.trim() === "*";
}

/**
 * The item's name: "PreToolUse on Bash: ./scripts/check.sh", or "Stop: ./notify.sh" when the
 * matcher matches everything or the event has no matcher.
 */
export function hookItemName(hook: Pick<HookDefinition, "event" | "matcher" | "handler">): string {
  const what = oneLine(hook.handler.target, MAX_NAME_COMMAND) || `(${hook.handler.type} hook)`;
  const showMatcher = !matchesEverything(hook.matcher) && !EVENTS_WITHOUT_MATCHER.has(hook.event);
  return showMatcher
    ? `${hook.event} on ${oneLine(hook.matcher ?? "", 60)}: ${what}`
    : `${hook.event}: ${what}`;
}

/** Whether dawg runs this handler, and what it ignores. Pure. */
export function hookSupport(hook: HookDefinition): HookSupport {
  const { event, handler } = hook;
  const tier = eventTier(event);
  if (tier === null) {
    return {
      status: "not-supported",
      notes: [`“${event}” is not an event Claude Code documents, so it never fires.`],
    };
  }
  if (tier === 2 && !isRunningEvent(event)) {
    return {
      status: "not-supported",
      notes: [`dawg does not run ${event} hooks yet; they come next in Phase 4.`],
    };
  }
  if (tier === 3) {
    return { status: "not-supported", notes: [`dawg does not run ${event} hooks yet.`] };
  }
  if (handler.type !== "command") {
    const known = (HANDLER_TYPES as readonly string[]).includes(handler.type);
    return {
      status: "not-supported",
      notes: [
        known
          ? `dawg does not run ${handler.type} hooks yet; only command hooks run in this version.`
          : `“${handler.type}” is not a hook type Claude Code documents.`,
      ],
    };
  }
  if (handler.shell !== null && handler.shell !== "bash") {
    return {
      status: "not-supported",
      notes: [`dawg runs hooks with the system shell; “shell: ${handler.shell}” is not supported.`],
    };
  }

  const notes: string[] = [];
  if (handler.asyncRewake) {
    notes.push(
      "asyncRewake is not supported: the hook runs in the background, but its exit code does not wake the session.",
    );
  }
  if (handler.statusMessage !== null) {
    notes.push("statusMessage is not shown while the hook runs.");
  }
  if (handler.unknownKeys.length > 0) {
    notes.push(`Not used by dawg: ${handler.unknownKeys.join(", ")}.`);
  }
  const partly = notes.length > 0;
  // Documented behaviour, worth saying because it surprises: these are not dawg's gaps.
  if (handler.if !== null && !EVENTS_WITH_IF.has(event)) {
    notes.push(
      `“if” only applies to tool events, so on ${event} this hook never runs (as in Claude Code).`,
    );
  }
  if (!matchesEverything(hook.matcher) && EVENTS_WITHOUT_MATCHER.has(event)) {
    notes.push(
      `${event} hooks have no matcher, so “${hook.matcher}” is ignored (as in Claude Code).`,
    );
  }
  return { status: partly ? "partly-supported" : "loaded", notes };
}

/** Largest script read when looking for the transcript gap. */
const MAX_SCRIPT_BYTES = 1024 * 1024;

/**
 * Words of a command line, quotes removed and adjacent parts joined, as a shell reads them:
 * `"$CLAUDE_PROJECT_DIR"/hooks/x.sh` is one word. Good enough to find the files it names.
 */
function words(command: string): string[] {
  const out: string[] = [];
  let word = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || word !== "") out.push(word);
      word = "";
      started = false;
    } else {
      word += ch;
    }
  }
  if (started || word !== "") out.push(word);
  return out.filter((w) => w !== "");
}

/** The files a command line names that may be scripts: its program and arguments. */
function candidateFiles(hook: HookDefinition, projectDir: string, homeDir: string): string[] {
  const { handler } = hook;
  const parts =
    handler.args === null ? words(handler.command ?? "") : [handler.command ?? "", ...handler.args];
  const out: string[] = [];
  for (const part of parts) {
    if (/^[|&;<>]/.test(part) || part.startsWith("-")) continue;
    const expanded = expandHome(
      part.replace(/\$\{?(CLAUDE_PROJECT_DIR|DAWG_PROJECT_DIR)\}?/g, projectDir),
      homeDir,
    );
    if (expanded.includes("$")) continue;
    // Hooks run in the project folder, so a relative path is the project's.
    out.push(isAbsolute(expanded) ? expanded : resolve(projectDir, expanded));
  }
  return out;
}

/**
 * True when the hook reads the session transcript: its command line names `transcript_path`, or
 * a script it runs does. Hooks that do are told the path of dawg's own transcript, which they
 * will not understand (spec, Hooks, "Known gap"). Never throws.
 */
export async function readsTranscript(
  hook: HookDefinition,
  context: { projectDir: string | null; homeDir: string },
): Promise<boolean> {
  if (hook.handler.type !== "command") return false;
  if (/transcript_path/.test(hook.handler.target)) return true;
  const projectDir = context.projectDir ?? context.homeDir;
  for (const file of candidateFiles(hook, projectDir, context.homeDir)) {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) continue;
      const text = await readFile(file, "utf8");
      if (text.includes("\u0000")) continue;
      if (/transcript_path/.test(text)) return true;
    } catch {
      // Not a file we can read: nothing to learn from it.
    }
  }
  return false;
}
