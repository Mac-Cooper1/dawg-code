import type { Pane, ResolvedTheme } from "../../shared/bridge.ts";
import type { TitleBarView } from "../state/types.ts";
import { Chip, Icon, IconButton } from "../ui/index.ts";
import { PANES, paneCount } from "./panes.ts";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import styles from "./TitleBar.module.css";
import { TitleBarFrame } from "./TitleBarFrame.tsx";

export interface TitleBarProps {
  view: TitleBarView;
  theme: ResolvedTheme;
  sidebarOpen: boolean;
  dockOpen: boolean;
  dockPane: Pane;
  onToggleSidebar(): void;
  /** Opens the dock on `pane`, or closes it when that pane is already showing. */
  onTogglePane(pane: Pane): void;
  onSetAppearance(appearance: ResolvedTheme): void;
}

/** The main window's title bar: sidebar toggle, session title and chips, pane buttons, theme. */
export function TitleBar(props: TitleBarProps) {
  const { view } = props;
  return (
    <TitleBarFrame>
      <IconButton
        icon="sidebar"
        label={props.sidebarOpen ? "Hide the sidebar" : "Show the sidebar"}
        aria-keyshortcuts="Meta+B"
        active={!props.sidebarOpen}
        onClick={props.onToggleSidebar}
      />
      <h1 className={styles.title}>{view.title}</h1>
      <span className={styles.chips}>
        {view.projectName && (
          <Chip icon="folder" title="Project">
            {view.projectName}
          </Chip>
        )}
        {view.worktreeLabel && (
          <Chip icon="branch" mono title={view.worktreeTitle ?? "Runs in a worktree"}>
            {view.worktreeLabel}
          </Chip>
        )}
      </span>
      <span className={styles.grow} />
      {view.sessionId !== null && (
        <nav className={styles.paneButtons} aria-label="Side panes">
          {PANES.map((pane) => {
            const active = props.dockOpen && props.dockPane === pane.id;
            const count = paneCount(pane.id, view);
            // Named in one string: hidden text after the visible label picks up a stray space
            // in Chromium's name ("Changes , 6 lines added").
            const name =
              pane.id === "changes" && view.changes
                ? `${pane.label}, ${view.changes.additions} lines added, ${view.changes.deletions} removed`
                : pane.id === "tasks" && count
                  ? `${pane.label}, ${count.label}`
                  : undefined;
            return (
              <button
                key={pane.id}
                type="button"
                className={styles.paneButton}
                aria-pressed={active}
                aria-label={name}
                onClick={() => props.onTogglePane(pane.id)}
              >
                <Icon name={pane.icon} />
                {pane.label}
                {pane.id === "changes" && view.changes && (
                  <>
                    <span className={styles.added} aria-hidden="true">
                      +{view.changes.additions}
                    </span>
                    <span className={styles.removed} aria-hidden="true">
                      −{view.changes.deletions}
                    </span>
                  </>
                )}
                {pane.id === "tasks" && count && (
                  <span className={styles.count} aria-hidden="true">
                    {count.text}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      )}
      <span className={styles.separator} aria-hidden="true" />
      <ThemeSwitch theme={props.theme} onSetAppearance={props.onSetAppearance} />
    </TitleBarFrame>
  );
}
