import { DOCK_WIDTH, SIDEBAR_WIDTH } from "../../shared/bridge.ts";
import { SidebarContainer } from "../sidebar/SidebarContainer.tsx";
import { selectChrome, selectSelectedSessionId, selectTitleBar } from "../state/selectors.ts";
import { useActions, useAppStore } from "../state/store.ts";
import styles from "./App.module.css";
import { Dock } from "./Dock.tsx";
import { EmptyMain } from "./EmptyMain.tsx";
import { NewSessionDialogContainer } from "./NewSessionDialog.tsx";
import { Notices } from "./Notices.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { run } from "./run.ts";
import { SessionArea } from "./SessionArea.tsx";
import { TitleBar } from "./TitleBar.tsx";

/**
 * The sessions view: title bar across the top; below it the sidebar, the main column (notices,
 * transcript, composer) and the pane dock, with resize handles between them.
 */
export function MainWindow() {
  const chrome = useAppStore(selectChrome);
  const titleBar = useAppStore(selectTitleBar);
  const selectedId = useAppStore(selectSelectedSessionId);
  const actions = useActions();
  const dockShown = chrome.dockOpen && selectedId !== null;

  return (
    <div className={styles.window}>
      <TitleBar
        view={titleBar}
        theme={chrome.theme}
        sidebarOpen={chrome.sidebarOpen}
        dockOpen={dockShown}
        dockPane={chrome.dockPane}
        onToggleSidebar={() => actions.setSidebarOpen(!chrome.sidebarOpen)}
        onTogglePane={(pane) => {
          if (dockShown && chrome.dockPane === pane) actions.closeDock();
          else actions.openPane(pane);
        }}
        onSetAppearance={(appearance) => run(actions.setAppearance(appearance))}
      />
      <div className={styles.body}>
        {chrome.sidebarOpen && (
          <>
            <SidebarContainer />
            <ResizeHandle
              label="Resize the sidebar"
              value={chrome.sidebarWidth}
              min={SIDEBAR_WIDTH.min}
              max={SIDEBAR_WIDTH.max}
              defaultValue={SIDEBAR_WIDTH.default}
              edge="right"
              onChange={(width) => actions.setSidebarWidth(width)}
            />
          </>
        )}
        <main className={styles.main}>
          <Notices
            notices={chrome.notices}
            connection={chrome.connection}
            onDismiss={(id) => actions.dismissNotice(id)}
          />
          {selectedId !== null ? (
            <SessionArea key={selectedId} sessionId={selectedId} />
          ) : (
            <EmptyMain onNewSession={() => run(actions.newSession())} />
          )}
        </main>
        {dockShown && (
          <>
            <ResizeHandle
              label="Resize the panes"
              value={chrome.dockWidth}
              min={DOCK_WIDTH.min}
              max={DOCK_WIDTH.max}
              defaultValue={DOCK_WIDTH.default}
              edge="left"
              onChange={(width) => actions.setDockWidth(width)}
            />
            <Dock
              pane={chrome.dockPane}
              view={titleBar}
              width={chrome.dockWidth}
              onSelectPane={(pane) => actions.openPane(pane)}
              onClose={() => actions.closeDock()}
            />
          </>
        )}
      </div>
      <NewSessionDialogContainer />
    </div>
  );
}
