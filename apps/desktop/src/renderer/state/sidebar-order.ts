/**
 * The order of the sidebar, shared by its selector and by the store, which picks the session to
 * show when the selected one is deleted.
 */
import type { SessionId } from "@dawg/protocol";
import type { SessionView } from "./types.ts";

export interface SidebarOrderGroup {
  projectDir: string;
  sessions: SessionView[];
}

/**
 * Sessions as the sidebar lists them: archived ones left out, titles filtered by `search`,
 * newest activity first, grouped by project in the order of each project's newest session.
 */
export function sidebarOrder(
  sessions: Readonly<Record<SessionId, SessionView>>,
  search: string,
): SidebarOrderGroup[] {
  const query = search.trim().toLowerCase();
  const ordered = Object.values(sessions)
    .filter((session) => !session.summary.archived)
    .sort(
      (a, b) => b.summary.lastActivityAt - a.summary.lastActivityAt || a.id.localeCompare(b.id),
    );
  const byProject = new Map<string, SessionView[]>();
  for (const session of ordered) {
    const title = session.summary.title ?? "New session";
    if (query !== "" && !title.toLowerCase().includes(query)) continue;
    const dir = session.summary.projectDir;
    const list = byProject.get(dir);
    if (list) list.push(session);
    else byProject.set(dir, [session]);
  }
  return [...byProject].map(([projectDir, list]) => ({ projectDir, sessions: list }));
}

/**
 * The session to show once `id` is gone, from the sidebar's groups of ids: the next one in its
 * project, else the one above it, else the nearest one of the next or previous project. A
 * session the sidebar does not list (archived, or filtered out) gives way to the first one.
 * Null when none is left.
 */
export function neighbourOf(
  groups: readonly (readonly SessionId[])[],
  id: SessionId,
): SessionId | null {
  for (const [g, group] of groups.entries()) {
    const index = group.indexOf(id);
    if (index === -1) continue;
    const near = group[index + 1] ?? group[index - 1];
    if (near !== undefined) return near;
    const after = groups.slice(g + 1).find((candidate) => candidate.length > 0);
    const before = groups
      .slice(0, g)
      .reverse()
      .find((candidate) => candidate.length > 0);
    return after?.[0] ?? before?.at(-1) ?? null;
  }
  return (
    groups.find((group) => group.some((other) => other !== id))?.find((other) => other !== id) ??
    null
  );
}
