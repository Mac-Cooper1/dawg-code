import { useMemo } from "react";
import { Notices } from "../app/Notices.tsx";
import { run } from "../app/run.ts";
import { useSystemTheme } from "../app/useTheme.ts";
import { getBridge } from "../bridge/index.ts";
import { useActions, useAppStore } from "../state/store.ts";
import { HooksPage } from "./HooksPage.tsx";
import { McpPage } from "./McpPage.tsx";
import { ModelsPage } from "./ModelsPage.tsx";
import { PermissionsPage, permissionProjects } from "./PermissionsPage.tsx";
import { ProjectSetupPageContainer } from "./ProjectSetupPageContainer.tsx";
import { SettingsView } from "./SettingsView.tsx";
import { SkillsPage } from "./SkillsPage.tsx";
import { SubagentsPage } from "./SubagentsPage.tsx";
import { WebPage } from "./WebPage.tsx";

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

/**
 * Settings → Hooks: the sidebar's projects, starting with the selected session's (else the
 * first), and the engine's list through the store.
 */
function HooksPageContainer() {
  const sessions = useAppStore((store) => store.sessions);
  const names = useAppStore((store) => store.projects);
  const homeDir = useAppStore((store) => store.homeDir);
  const selected = useAppStore((store) =>
    store.layout.selectedSessionId === null
      ? null
      : (store.sessions[store.layout.selectedSessionId]?.summary.projectDir ?? null),
  );
  const actions = useActions();
  const projects = useMemo(() => permissionProjects(sessions, names), [sessions, names]);
  return (
    <HooksPage
      projects={projects}
      initialProject={selected ?? projects[0]?.dir ?? null}
      homeDir={homeDir}
      listHooks={actions.listHooks}
      setHookEnabled={actions.setHookEnabled}
      onReview={(projectDir) => actions.reviewProjectCode(projectDir)}
    />
  );
}

/**
 * Settings → Skills and commands: the sidebar's projects, starting with the selected session's
 * (else the first), and the engine's list through the store.
 */
function SkillsPageContainer() {
  const sessions = useAppStore((store) => store.sessions);
  const names = useAppStore((store) => store.projects);
  const homeDir = useAppStore((store) => store.homeDir);
  const selected = useAppStore((store) =>
    store.layout.selectedSessionId === null
      ? null
      : (store.sessions[store.layout.selectedSessionId]?.summary.projectDir ?? null),
  );
  const actions = useActions();
  const projects = useMemo(() => permissionProjects(sessions, names), [sessions, names]);
  return (
    <SkillsPage
      projects={projects}
      initialProject={selected ?? projects[0]?.dir ?? null}
      homeDir={homeDir}
      listSkills={actions.listSkills}
      onOpenFile={(path) => run(actions.openConfigFile(path))}
    />
  );
}

/**
 * Settings → Subagents: the sidebar's projects, starting with the selected session's (else the
 * first), the engine's list and the "New subagent" form through the store, and files opened in
 * the person's editor.
 */
function SubagentsPageContainer() {
  const sessions = useAppStore((store) => store.sessions);
  const names = useAppStore((store) => store.projects);
  const homeDir = useAppStore((store) => store.homeDir);
  const selected = useAppStore((store) =>
    store.layout.selectedSessionId === null
      ? null
      : (store.sessions[store.layout.selectedSessionId]?.summary.projectDir ?? null),
  );
  const actions = useActions();
  const projects = useMemo(() => permissionProjects(sessions, names), [sessions, names]);
  return (
    <SubagentsPage
      projects={projects}
      initialProject={selected ?? projects[0]?.dir ?? null}
      homeDir={homeDir}
      listSubagents={actions.listSubagents}
      createSubagent={actions.createSubagent}
      onOpenFile={(path) => run(actions.openConfigFile(path))}
    />
  );
}

/**
 * Settings → MCP servers: the sidebar's projects, starting with the selected session's (else the
 * first), and the engine's servers through the store.
 */
function McpPageContainer() {
  const sessions = useAppStore((store) => store.sessions);
  const names = useAppStore((store) => store.projects);
  const homeDir = useAppStore((store) => store.homeDir);
  const selected = useAppStore((store) =>
    store.layout.selectedSessionId === null
      ? null
      : (store.sessions[store.layout.selectedSessionId]?.summary.projectDir ?? null),
  );
  const actions = useActions();
  const projects = useMemo(() => permissionProjects(sessions, names), [sessions, names]);
  return (
    <McpPage
      projects={projects}
      initialProject={selected ?? projects[0]?.dir ?? null}
      homeDir={homeDir}
      listMcpServers={actions.listMcpServers}
      restartMcpServer={actions.restartMcpServer}
      setMcpServerEnabled={actions.setMcpServerEnabled}
      previewMcpImport={actions.previewMcpImport}
      importMcpServers={actions.importMcpServers}
      signInMcpServer={actions.signInMcpServer}
      signOutMcpServer={actions.signOutMcpServer}
      cancelMcpSignIn={actions.cancelMcpSignIn}
      // The authorization page goes through main's openExternal, which checks the address.
      onOpenLink={(url) => run(actions.openExternal(url))}
      onReview={(projectDir) => actions.reviewProjectCode(projectDir)}
    />
  );
}

/** Settings → Web: the search service, through the bridge; links open in the browser. */
function WebPageContainer() {
  const actions = useActions();
  return <WebPage api={getBridge().web} onOpenLink={(url) => run(actions.openExternal(url))} />;
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
      setupPage={<ProjectSetupPageContainer />}
      hooksPage={<HooksPageContainer />}
      skillsPage={<SkillsPageContainer />}
      subagentsPage={<SubagentsPageContainer />}
      mcpPage={<McpPageContainer />}
      webPage={<WebPageContainer />}
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
