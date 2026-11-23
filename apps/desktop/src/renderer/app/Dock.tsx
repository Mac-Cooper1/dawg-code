import { Tabs } from "radix-ui";
import type { Pane } from "../../shared/bridge.ts";
import type { TitleBarView } from "../state/types.ts";
import { Icon, IconButton } from "../ui/index.ts";
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
 * The pane dock at the right of the window: a tab per pane and a close button. The panes arrive
 * in later builds; each shows what it will hold.
 */
export function Dock(props: DockProps) {
  return (
    <aside className={styles.dock} style={{ width: props.width }} aria-label="Side panes">
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
        {PANES.map((pane) => (
          <Tabs.Content key={pane.id} value={pane.id} className={styles.body}>
            <div className={styles.empty}>
              <Icon name={pane.icon} size={20} />
              <h2 className={styles.emptyTitle}>{pane.label}</h2>
              <p className={styles.emptyText}>{pane.description} It arrives in a later build.</p>
            </div>
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </aside>
  );
}
