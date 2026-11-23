/** The side panes, in title-bar and tab order, with what each will show. */
import type { Pane } from "../../shared/bridge.ts";
import type { TitleBarView } from "../state/types.ts";
import type { IconName } from "../ui/index.ts";

export interface PaneInfo {
  id: Pane;
  label: string;
  icon: IconName;
  /** One line for the pane's empty state in this build. */
  description: string;
}

export const PANES: readonly PaneInfo[] = [
  {
    id: "changes",
    label: "Changes",
    icon: "changes",
    description: "Every file this session changed, as a diff you can comment on.",
  },
  {
    id: "files",
    label: "Files",
    icon: "file",
    description: "The project’s files and an editor, with the files dawg touched marked.",
  },
  {
    id: "terminal",
    label: "Terminal",
    icon: "terminal",
    description: "Your own shell in the session’s folder. dawg never types here.",
  },
  {
    id: "plan",
    label: "Plan",
    icon: "plan",
    description: "The plan you approved, read-only.",
  },
  {
    id: "tasks",
    label: "Tasks",
    icon: "tasks",
    description: "dawg’s task list and background commands, with live status.",
  },
];

/** The small count after a pane's name, where there is one: "3" files changed, "1/3" tasks. */
export function paneCount(pane: Pane, view: TitleBarView): { text: string; label: string } | null {
  if (pane === "changes" && view.changes) {
    const files = view.changes.files;
    return {
      text: String(files),
      label: files === 1 ? "1 file changed" : `${files} files changed`,
    };
  }
  if (pane === "tasks" && view.tasks) {
    const { done, total } = view.tasks;
    return { text: `${done}/${total}`, label: `${done} of ${total} done` };
  }
  return null;
}
