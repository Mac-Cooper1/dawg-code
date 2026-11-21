import { badRequest, notFound } from "../errors.js";

export function createCommentService(db, { users, tasks }) {
  return {
    listForTask(taskId) {
      tasks.get(taskId);
      return db
        .list("comments", { taskId })
        .map((c) => ({ ...c, author: users.displayName(c.authorId) }));
    },
    add(taskId, authorId, text) {
      tasks.get(taskId);
      if (typeof text !== "string" || !text.trim()) throw badRequest("text_required");
      return db.insert("comments", { taskId, authorId, text: text.trim() });
    },
    remove(id) {
      if (!db.get("comments", id)) throw notFound();
      db.remove("comments", id);
    },
  };
}
