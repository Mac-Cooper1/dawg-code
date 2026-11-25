import { run } from "../app/run.ts";
import { selectModelFooter, selectSidebar } from "../state/selectors.ts";
import { useActions, useAppStore } from "../state/store.ts";
import { Sidebar } from "./Sidebar.tsx";
import { useNow } from "./useNow.ts";

/** Relative times in the sidebar ("3m") are refreshed this often. */
const CLOCK_TICK_MS = 30_000;

/** The sidebar, connected to the store. */
export function SidebarContainer() {
  const now = useNow(CLOCK_TICK_MS);
  const groups = useAppStore((state) => selectSidebar(state, now));
  const footer = useAppStore(selectModelFooter);
  const search = useAppStore((state) => state.layout.search);
  const width = useAppStore((state) => state.layout.sidebarWidth);
  const actions = useActions();

  return (
    <Sidebar
      groups={groups}
      search={search}
      footer={footer}
      width={width}
      onSearch={(query) => actions.setSearch(query)}
      onNewSession={(projectDir) =>
        run(actions.newSession(projectDir === undefined ? undefined : { projectDir }))
      }
      onSelect={(id) => actions.selectSession(id)}
      onRename={(id, title) => run(actions.renameSession(id, title))}
      onFork={(id) => run(actions.forkSession(id))}
      onMarkUnread={(id) => actions.markUnread(id)}
      onArchive={(id) => run(actions.archiveSession(id))}
      onDelete={(id) => run(actions.deleteSession(id))}
      onOpenModelSettings={() => {
        actions.setSettingsPage("models");
        actions.setView("settings");
      }}
    />
  );
}
