import { badRequest, notFound } from "../errors.js";

export function createTaskService(db, { projects, tags }) {
  const get = (id) => {
    const task = db.get("tasks", id);
    if (!task) throw notFound();
    return task;
  };
  return {
    get,
    create(projectId, { title }) {
      projects.get(projectId);
      if (typeof title !== "string" || !title.trim()) throw badRequest("title_required");
      return db.insert("tasks", { projectId, title: title.trim(), done: false, tags: [] });
    },
    update(id, { title, done }) {
      get(id);
      const patch = {};
      if (typeof title === "string" && title.trim()) patch.title = title.trim();
      if (typeof done === "boolean") patch.done = done;
      return db.update("tasks", id, patch);
    },
    complete(id) {
      return this.update(id, { done: true });
    },
    remove(id) {
      get(id);
      for (const c of db.list("comments", { taskId: id })) db.remove("comments", c.id);
      db.remove("tasks", id);
    },
    addTag(id, name) {
      const task = get(id);
      const tag = tags.ensure(name);
      if (task.tags.includes(tag.name)) return task;
      return db.update("tasks", id, { tags: [...task.tags, tag.name] });
    },
  };
}
