import { notFound } from "../errors.js";

export function createUserService(db, { sessions }) {
  const get = (id) => {
    const user = db.get("users", id);
    if (!user) throw notFound();
    return user;
  };
  return {
    get,
    list: () => db.list("users"),
    displayName(id) {
      return db.get("users", id)?.name ?? "(deleted user)";
    },
    updateProfile(id, { name, email }) {
      get(id);
      const patch = {};
      if (typeof name === "string" && name.trim()) patch.name = name.trim();
      if (typeof email === "string" && email.includes("@")) patch.email = email;
      return db.update("users", id, patch);
    },
    remove(id) {
      get(id);
      sessions.revokeAll(id);
      db.remove("users", id);
    },
  };
}
