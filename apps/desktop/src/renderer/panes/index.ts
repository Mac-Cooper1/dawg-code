/**
 * The dock's panes, one folder each (`panes/<pane>/index.tsx`). Each exports one component that
 * takes `PaneProps`; the dock shows the selected pane's component for the selected session.
 */
import type { ComponentType } from "react";
import type { Pane } from "../../shared/bridge.ts";
import { ChangesPane } from "./changes/index.tsx";
import { FilesPane } from "./files/index.tsx";
import { PlanPane } from "./plan/index.tsx";
import { TasksPane } from "./tasks/index.tsx";
import { TerminalPane } from "./terminal/index.tsx";
import type { PaneProps } from "./types.ts";

export type { PaneProps } from "./types.ts";

export const PANE_COMPONENTS: Record<Pane, ComponentType<PaneProps>> = {
  changes: ChangesPane,
  files: FilesPane,
  terminal: TerminalPane,
  plan: PlanPane,
  tasks: TasksPane,
};
