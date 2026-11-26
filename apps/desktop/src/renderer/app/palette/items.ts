/**
 * The command palette's rows: the actions that apply now and the sessions, filtered by the query
 * and grouped under headings. Pure, so it is tested without rendering.
 *
 * With no query: recent sessions first, then recently used actions, then every action by group.
 * With a query: the best matches, grouped, the group with the best match first.
 */
import type { SessionId } from "@dawg/protocol";
import { basename, formatRelativeTime, shortenPath } from "../../lib/format.ts";
import { selectComposer } from "../../state/selectors.ts";
import { isQueuedForModel, MARK_LABELS, sessionMark } from "../../state/session-marks.ts";
import type { AppStore, SidebarMark } from "../../state/types.ts";
import type { Shortcut } from "../commands/keys.ts";
import { availability, COMMANDS, dynamicCommands } from "../commands/registry.ts";
import { COMMAND_GROUPS, type Command } from "../commands/types.ts";
import { matchScore, type Prepared, prepare, queryWords } from "./fuzzy.ts";

/** Sessions listed with no query. */
export const RECENT_SESSIONS = 6;
/** At most this many sessions match a query, so hundreds of sessions stay quick. */
export const MAX_SESSION_MATCHES = 50;

export const RECENT_SESSIONS_HEADING = "Recent sessions";
export const RECENTLY_USED_HEADING = "Recently used";
/** Matching sessions share the heading of the actions that start and switch sessions. */
export const SESSIONS_HEADING = "Sessions";

interface RowBase {
  /** Unique among the rows; part of the option's element id. */
  key: string;
  title: string;
  /** Muted, after the title: a session's project and time, or why an action cannot run. */
  detail: string | null;
}

export interface CommandRow extends RowBase {
  kind: "command";
  command: Command;
  /** Why it cannot run now; such rows show only for a query, and do nothing. */
  disabled: string | null;
  /** The option in effect (the current mode). */
  checked: boolean;
  shortcut: Shortcut | null;
}

export interface SessionRow extends RowBase {
  kind: "session";
  sessionId: SessionId;
  mark: SidebarMark;
  markLabel: string;
  /** The session the window shows. */
  current: boolean;
}

export type PaletteRow = CommandRow | SessionRow;

export interface PaletteSection {
  heading: string;
  rows: PaletteRow[];
}

interface Entry<R extends PaletteRow> {
  row: R;
  text: Prepared;
}

/** Everything the palette can list, worked out once when it opens. */
export interface PaletteSource {
  commands: Entry<CommandRow>[];
  /** Most recent activity first. */
  sessions: Entry<SessionRow>[];
}

/** Actions the palette runs: every action with `run`, but not the palette's own key. */
function paletteCommands(state: AppStore): Command[] {
  return [...COMMANDS, ...dynamicCommands(state)].filter(
    (command) => command.run !== undefined && command.id !== "palette.toggle",
  );
}

export function buildSource(state: AppStore, now: number): PaletteSource {
  const commands: Entry<CommandRow>[] = [];
  for (const command of paletteCommands(state)) {
    const can = availability(command, state);
    if (can === false) continue;
    const row: CommandRow = {
      kind: "command",
      key: `command-${command.id}`,
      title: command.title,
      detail: typeof can === "string" ? can : null,
      command,
      disabled: typeof can === "string" ? can : null,
      checked: command.checked?.(state) ?? false,
      shortcut: command.shortcut?.keys[0] ?? null,
    };
    commands.push({
      row,
      text: prepare({
        title: command.title,
        extra: [command.group, ...(command.keywords ?? [])].join(" · "),
      }),
    });
  }

  const selected = state.layout.selectedSessionId;
  const queuedCount = Object.values(state.sessions).filter(isQueuedForModel).length;
  // First run shows in place of the sessions, until a model runs: nothing to open yet.
  const listed = state.onboarding === null ? Object.values(state.sessions) : [];
  const sessions = listed
    .filter((session) => !session.summary.archived)
    .sort((a, b) => b.summary.lastActivityAt - a.summary.lastActivityAt || a.id.localeCompare(b.id))
    .map((session): Entry<SessionRow> => {
      const { summary } = session;
      const projectName = state.projects[summary.projectDir]?.name ?? basename(summary.projectDir);
      const { mark } = sessionMark({
        session,
        pending: state.pending[session.id] ?? [],
        items: state.transcripts[session.id] ?? [],
        seenSeq: state.ui.seenSeq[session.id],
        markedUnread: state.ui.markedUnread[session.id] ?? false,
        stoppedByUser: state.ui.stoppedByUser[session.id] ?? false,
        selected: session.id === selected,
        queuedCount,
      });
      const time = mark === "working" ? "now" : formatRelativeTime(summary.lastActivityAt, now);
      const title = summary.title ?? "New session";
      return {
        row: {
          kind: "session",
          key: `session-${session.id}`,
          sessionId: session.id,
          title,
          detail: `${projectName} · ${time}`,
          mark,
          markLabel: MARK_LABELS[mark],
          current: session.id === selected && state.layout.view === "sessions",
        },
        text: prepare({
          // Untitled sessions are all "New session"; their title should not outrank the action.
          title: summary.title ?? "",
          extra: [projectName, shortenPath(summary.projectDir, state.homeDir)].join(" · "),
        }),
      };
    });
  return { commands, sessions };
}

function groupRows(commands: readonly CommandRow[]): PaletteSection[] {
  const sections: PaletteSection[] = [];
  for (const group of COMMAND_GROUPS) {
    const rows = commands.filter((row) => row.command.group === group);
    if (rows.length > 0) sections.push({ heading: group, rows });
  }
  return sections;
}

/** The rows for `query`, under their headings. */
export function paletteSections(
  source: PaletteSource,
  query: string,
  recentIds: readonly string[],
): PaletteSection[] {
  const words = queryWords(query);
  if (words.length === 0) return browseSections(source, recentIds);

  const scored: { row: PaletteRow; score: number; heading: string }[] = [];
  let sessionMatches = 0;
  for (const { row, text } of source.sessions) {
    if (sessionMatches >= MAX_SESSION_MATCHES) break;
    const score = matchScore(words, text);
    if (score === null) continue;
    sessionMatches += 1;
    scored.push({ row, score, heading: SESSIONS_HEADING });
  }
  for (const { row, text } of source.commands) {
    const score = matchScore(words, text);
    if (score === null) continue;
    const recent = recentIds.indexOf(row.command.id);
    const bonus = (recent === -1 ? 0 : 10 - recent) - (row.disabled ? 30 : 0);
    scored.push({ row, score: score + bonus, heading: row.command.group });
  }
  scored.sort((a, b) => b.score - a.score);

  // Sections keep the order of their best row; rows keep their order within a section.
  const byHeading = new Map<string, PaletteRow[]>();
  for (const { row, heading } of scored) {
    const rows = byHeading.get(heading);
    if (rows) rows.push(row);
    else byHeading.set(heading, [row]);
  }
  return [...byHeading].map(([heading, rows]) => ({ heading, rows }));
}

function browseSections(source: PaletteSource, recentIds: readonly string[]): PaletteSection[] {
  const sections: PaletteSection[] = [];
  const sessions = source.sessions
    .filter(({ row }) => !row.current)
    .slice(0, RECENT_SESSIONS)
    .map(({ row }) => row);
  if (sessions.length > 0) sections.push({ heading: RECENT_SESSIONS_HEADING, rows: sessions });

  // Only what can run now: the reasons are for someone searching for an action.
  const enabled = source.commands.map(({ row }) => row).filter((row) => row.disabled === null);
  const recent = recentIds
    .map((id) => enabled.find((row) => row.command.id === id))
    .filter((row): row is CommandRow => row !== undefined);
  if (recent.length > 0) sections.push({ heading: RECENTLY_USED_HEADING, rows: recent });
  const rest = enabled.filter((row) => !recent.includes(row));
  return [...sections, ...groupRows(rest)];
}

/** Whether the selected session is working: for the delete confirmation. */
export function isSessionWorking(state: AppStore, id: SessionId): boolean {
  const session = state.sessions[id];
  if (session) return session.status === "working" || session.activeTurnId !== null;
  return selectComposer(state, id)?.working ?? false;
}
