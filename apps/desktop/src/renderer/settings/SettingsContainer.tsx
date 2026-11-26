import { useMemo } from "react";
import { Notices } from "../app/Notices.tsx";
import { run } from "../app/run.ts";
import { useSystemTheme } from "../app/useTheme.ts";
import { getBridge } from "../bridge/index.ts";
import { useActions, useAppStore } from "../state/store.ts";
import { ModelsPage } from "./ModelsPage.tsx";
import { PermissionsPage, permissionProjects } from "./PermissionsPage.tsx";
import { SettingsView } from "./SettingsView.tsx";

/** Settings → Models, connected to the store: it follows every models state, progress included. */
function ModelsPageContainer() {
  const state = useAppStore((store) => store.modelsState);
  const actions = useActions();
  return <ModelsPage state={state} actions={actions} />;
}

/**
 * Settings → Permissions: the sidebar's projects, starting with the selected session's (else
 * the first), and the settings files through the bridge.
 */
function PermissionsPageContainer() {
  const sessions = useAppStore((store) => store.sessions);
  const names = useAppStore((store) => store.projects);
  const homeDir = useAppStore((store) => store.homeDir);
  const selected = useAppStore((store) =>
    store.layout.selectedSessionId === null
      ? null
      : (store.sessions[store.layout.selectedSessionId]?.summary.projectDir ?? null),
  );
  const projects = useMemo(() => permissionProjects(sessions, names), [sessions, names]);
  return (
    <PermissionsPage
      api={getBridge().permissions}
      projects={projects}
      initialProject={selected ?? projects[0]?.dir ?? null}
      homeDir={homeDir}
    />
  );
}

function SettingsNotices() {
  const notices = useAppStore((state) => state.notices);
  const actions = useActions();
  return <Notices notices={notices} onDismiss={(id) => actions.dismissNotice(id)} />;
}

/** Settings, connected to the store. */
export function SettingsContainer() {
  const page = useAppStore((state) => state.layout.settingsPage);
  const appearance = useAppStore((state) => state.settings.appearance);
  const toolCalls = useAppStore((state) => state.settings.toolCalls);
  const notifications = useAppStore((state) => state.settings.notifications);
  const dockBadge = useAppStore((state) => state.settings.dockBadge);
  const newSessionWorktree = useAppStore((state) => state.settings.newSessionWorktree);
  const theme = useAppStore((state) => state.resolvedTheme);
  const system = useSystemTheme();
  const actions = useActions();

  return (
    <SettingsView
      page={page}
      appearance={appearance}
      system={system}
      theme={theme}
      toolCalls={toolCalls}
      notifications={notifications}
      dockBadge={dockBadge}
      newSessionWorktree={newSessionWorktree}
      modelsPage={<ModelsPageContainer />}
      permissionsPage={<PermissionsPageContainer />}
      notices={<SettingsNotices />}
      onSelectPage={(next) => actions.setSettingsPage(next)}
      onSetAppearance={(next) => run(actions.setAppearance(next))}
      onSetToolCallDisplay={(next) => run(actions.setToolCallDisplay(next))}
      onSetNotifications={(on) => run(actions.setNotifications(on))}
      onSetDockBadge={(on) => run(actions.setDockBadge(on))}
      onSetNewSessionWorktree={(next) => run(actions.setNewSessionWorktree(next))}
      onBack={() => actions.setView("sessions")}
    />
  );
}
