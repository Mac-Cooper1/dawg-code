import { badRequest } from "../errors.js";

export function createTagService(db) {
  const byName = (name) => db.find("tags", (t) => t.name === name)[0];
  return {
    list: () => db.list("tags"),
    create(name) {
      if (typeof name !== "string" || !/^[a-z0-9-]+$/.test(name)) throw badRequest("bad_tag");
      return byName(name) ?? db.insert("tags", { name });
    },
    /** Returns the tag, creating it the first time a name is used. */
    ensure(name) {
      return this.create(name);
    },
  };
}
