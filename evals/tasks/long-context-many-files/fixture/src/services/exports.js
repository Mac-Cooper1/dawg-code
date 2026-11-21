// Project export (JSON download). Exports are audited because they contain
// everything about a project.
export function createExportService(db, { projects, audit }) {
  return {
    exportProject(id, actorId) {
      const project = projects.get(id);
      const tasks = projects.tasks(id);
      audit.record(actorId, "export", id);
      return { project, tasks };
    },
  };
}
