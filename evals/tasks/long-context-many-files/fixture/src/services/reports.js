// Board statistics. summary() is computed live; rebuild() stores a snapshot
// that the weekly e-mail job reads.
export function createReportService(db) {
  const compute = () => ({
    projects: db.count("projects", { archived: false }),
    openTasks: db.count("tasks", { done: false }),
    doneTasks: db.count("tasks", { done: true }),
    comments: db.count("comments"),
  });
  return {
    summary: compute,
    rebuild() {
      const stats = compute();
      const [existing] = db.list("reports", { kind: "weekly" });
      if (existing) return db.update("reports", existing.id, { stats, at: db.tick() });
      return db.insert("reports", { kind: "weekly", stats, at: db.tick() });
    },
  };
}
