import { useMemo } from "react";
import { useActions, useAppStore } from "../state/store.ts";
import { permissionProjects } from "./PermissionsPage.tsx";
import { ProjectSetupPage } from "./ProjectSetupPage.tsx";

/**
 * Settings → Project setup, connected to the store: the sidebar's projects, starting with the
 * selected session's (else the first), and the report through the engine (`inspectProject`).
 */
export function ProjectSetupPageContainer() {
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
    <ProjectSetupPage
      projects={projects}
      initialProject={selected ?? projects[0]?.dir ?? null}
      homeDir={homeDir}
      inspect={(projectDir) => actions.inspectProject(projectDir)}
      onReview={(projectDir) => actions.reviewProjectCode(projectDir)}
    />
  );
}
