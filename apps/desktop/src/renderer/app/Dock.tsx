import { Tabs } from "radix-ui";
import { useRef } from "react";
import type { Pane } from "../../shared/bridge.ts";
import { PANE_COMPONENTS } from "../panes/index.ts";
import type { TitleBarView } from "../state/types.ts";
import { useFocusFallback } from "../ui/focus.ts";
import { IconButton } from "../ui/index.ts";
import styles from "./Dock.module.css";
import { PANES, paneCount } from "./panes.ts";

export interface DockProps {
  pane: Pane;
  /** For the counts on the tabs (files changed, tasks done). */
  view: TitleBarView;
  width: number;
  onSelectPane(pane: Pane): void;
  onClose(): void;
}

function isPane(value: string): value is Pane {
  return PANES.some((pane) => pane.id === value);
}

/**
 * The pane dock at the right of the window: a tab per pane and a close button. Each pane is its
 * own component (`src/renderer/panes/<pane>/`), shown for the selected session.
 */
export function Dock(props: DockProps) {
  // Closed with focus inside (its close button, ⌥⌘B): focus goes to the message field.
  const ref = useRef<HTMLElement>(null);
  useFocusFallback(ref);
  return (
    <aside ref={ref} className={styles.dock} style={{ width: props.width }} aria-label="Side panes">
      <Tabs.Root
        className={styles.tabsRoot}
        value={props.pane}
        onValueChange={(value) => {
          if (isPane(value)) props.onSelectPane(value);
        }}
      >
        <div className={styles.tabBar}>
          <Tabs.List className={styles.tabList} aria-label="Panes">
            {PANES.map((pane) => {
              const count = paneCount(pane.id, props.view);
              return (
                <Tabs.Trigger key={pane.id} value={pane.id} className={styles.tab}>
                  {pane.label}
                  {count && (
                    <>
                      <span className={styles.count} aria-hidden="true">
                        {count.text}
                      </span>
                      <span className="vh">, {count.label}</span>
                    </>
                  )}
                </Tabs.Trigger>
              );
            })}
          </Tabs.List>
          <span className={styles.grow} />
          <IconButton icon="close" label="Close the panes" onClick={props.onClose} />
        </div>
        {PANES.map((pane) => {
          const Body = PANE_COMPONENTS[pane.id];
          const sessionId = props.view.sessionId;
          return (
            <Tabs.Content key={pane.id} value={pane.id} className={styles.body}>
              {sessionId !== null && <Body sessionId={sessionId} />}
            </Tabs.Content>
          );
        })}
      </Tabs.Root>
    </aside>
  );
}
