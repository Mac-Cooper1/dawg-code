import { badRequest, notFound } from "../errors.js";

export function createProjectService(db) {
  const get = (id) => {
    const project = db.get("projects", id);
    if (!project) throw notFound();
    return project;
  };
  return {
    get,
    list({ includeArchived = false } = {}) {
      return db.find("projects", (p) => includeArchived || !p.archived);
    },
    tasks(id) {
      get(id);
      return db.list("tasks", { projectId: id });
    },
    create({ name, ownerId }) {
      if (typeof name !== "string" || !name.trim()) throw badRequest("name_required");
      return db.insert("projects", { name: name.trim(), ownerId, archived: false });
    },
    rename(id, name) {
      get(id);
      if (typeof name !== "string" || !name.trim()) throw badRequest("name_required");
      return db.update("projects", id, { name: name.trim() });
    },
    archive(id) {
      get(id);
      return db.update("projects", id, { archived: true });
    },
    restore(id) {
      get(id);
      return db.update("projects", id, { archived: false });
    },
  };
}
