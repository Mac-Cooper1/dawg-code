// A tiny in-memory document store. Reads: get, list, find, count.
// Writes: insert, update, remove. Documents are copied in and out, so callers
// can't mutate stored data by accident.

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

const PREFIX = {
  users: "u",
  projects: "p",
  tasks: "t",
  comments: "c",
  tags: "g",
  sessions: "s",
  audit: "a",
  reports: "r",
};

export function createDb(seed) {
  const data = clone(seed);
  let nextId = 100;
  let clock = 0;

  const collection = (name) => {
    if (!data[name]) throw new Error(`unknown collection ${name}`);
    return data[name];
  };
  const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => doc[k] === v);

  return {
    get(name, id) {
      return clone(collection(name).find((doc) => doc.id === id));
    },
    list(name, filter = {}) {
      return clone(collection(name).filter((doc) => matches(doc, filter)));
    },
    find(name, predicate) {
      return clone(collection(name).filter(predicate));
    },
    count(name, filter = {}) {
      return collection(name).filter((doc) => matches(doc, filter)).length;
    },
    insert(name, doc) {
      const stored = { id: `${PREFIX[name]}${nextId++}`, ...clone(doc) };
      collection(name).push(stored);
      return clone(stored);
    },
    update(name, id, patch) {
      const doc = collection(name).find((d) => d.id === id);
      if (!doc) return undefined;
      Object.assign(doc, clone(patch));
      return clone(doc);
    },
    remove(name, id) {
      const docs = collection(name);
      const index = docs.findIndex((d) => d.id === id);
      if (index === -1) return false;
      docs.splice(index, 1);
      return true;
    },
    /** Logical clock for timestamps (keeps tests deterministic). Not a write. */
    tick() {
      clock += 1;
      return clock;
    },
    /** Serialised copy of all data, for debugging and tests. */
    snapshot() {
      return JSON.stringify(data);
    },
  };
}
