// Full-text-ish search over project names and task titles. Read-only.
export function createSearchService(db) {
  return {
    search(query) {
      const q = String(query ?? "").toLowerCase().trim();
      if (!q) return { projects: [], tasks: [] };
      return {
        projects: db.find("projects", (p) => p.name.toLowerCase().includes(q)).map((p) => p.id),
        tasks: db.find("tasks", (t) => t.title.toLowerCase().includes(q)).map((t) => t.id),
      };
    },
  };
}
