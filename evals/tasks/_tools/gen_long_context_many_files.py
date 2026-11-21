#!/usr/bin/env python3
"""Generate the fixture for long-context-many-files.

A small in-memory REST service ("teamboard") with 30 route files and 10
service modules. The task is to add the permission model in
docs/permissions.md, which needs reading every route and the services it
calls. Writes everything under long-context-many-files/fixture/ (the hand-written
checker, hidden tests and solution live next to it and are not generated).

Re-running this script overwrites the fixture files listed here and nothing else.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(os.path.dirname(HERE), "long-context-many-files", "fixture")

FILES = {}

FILES["package.json"] = """{
  "name": "teamboard-api",
  "version": "0.7.0",
  "private": true,
  "type": "module",
  "description": "In-memory API for a small team task board.",
  "scripts": {
    "test": "node --test"
  }
}
"""

FILES["README.md"] = """# teamboard-api

The API behind our team task board: projects, tasks, comments, tags, users
and reports. Storage is in memory (`src/db.js`); `src/seed.js` has demo data.

- `src/app.js` builds the app: `createApp()` returns `{ handle, db }`.
  `handle(request)` takes `{ method, path, body, auth }` and returns
  `{ status, body }`.
- `src/routes/` has one file per route; `src/routes/index.js` lists them.
- `src/services/` has the business logic the routes call.
- `docs/permissions.md` describes the access rules.

Requests carry `auth: { userId, scopes }` once the gateway has checked the
caller's token; requests without a token have no `auth` at all.

Run the tests with `node --test`.
"""

FILES["docs/permissions.md"] = """# Permissions

Status: agreed, **not implemented yet**. Today every route is open.

## Scopes

A request's `auth.scopes` is a list drawn from `read`, `write` and `admin`.
They are ordered: `write` includes everything `read` allows, and `admin`
includes everything `write` allows. Unknown scope strings are ignored.

## Which scope a route needs

1. **Public routes** need nothing: `GET /health` and `GET /version`.
2. Any route whose path starts with `/admin/` needs `admin`.
3. Every other route needs `write` if handling the request can modify the
   database (`db.insert`, `db.update` or `db.remove`), directly in the route
   or through any service it calls, on any code path. Otherwise it needs
   `read`.

The HTTP method does not decide it: some GET routes write and some POST routes
only read. Look at what the code does.

## Responses

- Request without `auth` to a non-public route: status `401`, body
  `{ "error": "unauthenticated" }`.
- Request with `auth` whose scopes are not enough: status `403`, body
  `{ "error": "forbidden", "required": "<scope the route needs>" }`.
- These checks happen before the route's handler runs, so a rejected request
  never changes anything.
- Unknown routes still answer `404` whatever the auth.
"""

FILES["src/errors.js"] = """export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code machine-readable error code, sent as body.error
   */
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export const notFound = () => new HttpError(404, "not_found");
export const badRequest = (code = "bad_request") => new HttpError(400, code);
"""

FILES["src/db.js"] = """// A tiny in-memory document store. Reads: get, list, find, count.
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
"""

FILES["src/seed.js"] = """export const SEED = {
  users: [
    { id: "u1", name: "Ada", email: "ada@example.test", role: "lead" },
    { id: "u2", name: "Bo", email: "bo@example.test", role: "member" },
    { id: "u3", name: "Cy", email: "cy@example.test", role: "member" },
  ],
  projects: [
    { id: "p1", name: "Website", ownerId: "u1", archived: false },
    { id: "p2", name: "Mobile app", ownerId: "u2", archived: false },
    { id: "p3", name: "Old intranet", ownerId: "u1", archived: true },
  ],
  tasks: [
    { id: "t1", projectId: "p1", title: "Fix header", done: false, tags: ["bug"] },
    { id: "t2", projectId: "p1", title: "New pricing page", done: false, tags: [] },
    { id: "t3", projectId: "p2", title: "Offline mode", done: true, tags: ["feature"] },
  ],
  comments: [
    { id: "c1", taskId: "t1", authorId: "u2", text: "Only on Safari?" },
    { id: "c2", taskId: "t1", authorId: "u1", text: "Yes, 17.2 and up." },
  ],
  tags: [
    { id: "g1", name: "bug" },
    { id: "g2", name: "feature" },
  ],
  sessions: [
    { id: "s1", userId: "u1", lastSeen: 0 },
    { id: "s2", userId: "u2", lastSeen: 0 },
    { id: "s3", userId: "u3", lastSeen: 0 },
  ],
  audit: [],
  reports: [],
};
"""

FILES["src/router.js"] = """// Matches "METHOD /path" against route patterns with :params.

function compile(path) {
  const names = [];
  const pattern = path.replace(/:([a-zA-Z]+)/g, (_, name) => {
    names.push(name);
    return "([^/]+)";
  });
  return { regex: new RegExp(`^${pattern}$`), names };
}

export function createRouter(routes) {
  const compiled = routes.map((route) => ({ route, ...compile(route.path) }));
  return {
    match(method, path) {
      for (const { route, regex, names } of compiled) {
        if (route.method !== method) continue;
        const m = regex.exec(path);
        if (!m) continue;
        const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        return { route, params };
      }
      return null;
    },
  };
}
"""

FILES["src/app.js"] = """import { createDb } from "./db.js";
import { HttpError } from "./errors.js";
import { createRouter } from "./router.js";
import { routes } from "./routes/index.js";
import { SEED } from "./seed.js";
import { createServices } from "./services/index.js";

/**
 * @param {{ db?: ReturnType<typeof createDb> }} [options]
 */
export function createApp({ db = createDb(SEED) } = {}) {
  const services = createServices(db);
  const router = createRouter(routes);

  /**
   * @param {{ method: string, path: string, body?: any, auth?: { userId: string, scopes: string[] } }} request
   * @returns {{ status: number, body: any }}
   */
  function handle({ method, path, body = {}, auth }) {
    const found = router.match(method, path);
    if (!found) return { status: 404, body: { error: "not_found" } };
    try {
      return found.route.handler({ params: found.params, body, auth, services, db });
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: { error: err.code } };
      throw err;
    }
  }

  return { handle, db };
}
"""

# ---------------------------------------------------------------- services

FILES["src/services/index.js"] = """import { createAuditService } from "./audit.js";
import { createCommentService } from "./comments.js";
import { createExportService } from "./exports.js";
import { createProjectService } from "./projects.js";
import { createReportService } from "./reports.js";
import { createSearchService } from "./search.js";
import { createSessionService } from "./sessions.js";
import { createTagService } from "./tags.js";
import { createTaskService } from "./tasks.js";
import { createUserService } from "./users.js";

export function createServices(db) {
  const audit = createAuditService(db);
  const sessions = createSessionService(db);
  const users = createUserService(db, { sessions });
  const tags = createTagService(db);
  const projects = createProjectService(db);
  const tasks = createTaskService(db, { projects, tags });
  const comments = createCommentService(db, { users, tasks });
  const search = createSearchService(db);
  const reports = createReportService(db);
  const exports = createExportService(db, { projects, audit });
  return { audit, sessions, users, tags, projects, tasks, comments, search, reports, exports };
}
"""

FILES["src/services/audit.js"] = """// Audit trail of sensitive actions.
export function createAuditService(db) {
  return {
    record(actorId, action, target) {
      return db.insert("audit", { actorId, action, target, at: db.tick() });
    },
    list() {
      return db.list("audit");
    },
  };
}
"""

FILES["src/services/sessions.js"] = """// Login sessions, one per user, maintained by the gateway.
export function createSessionService(db) {
  return {
    /** The caller's session. Also marks it as seen, for the "active now" list. */
    current(userId) {
      const [session] = db.find("sessions", (s) => s.userId === userId);
      if (!session) return null;
      return db.update("sessions", session.id, { lastSeen: db.tick() });
    },
    revokeAll(userId) {
      for (const s of db.find("sessions", (x) => x.userId === userId)) db.remove("sessions", s.id);
    },
  };
}
"""

FILES["src/services/users.js"] = """import { notFound } from "../errors.js";

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
"""

FILES["src/services/projects.js"] = """import { badRequest, notFound } from "../errors.js";

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
"""

FILES["src/services/tags.js"] = """import { badRequest } from "../errors.js";

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
"""

FILES["src/services/tasks.js"] = """import { badRequest, notFound } from "../errors.js";

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
"""

FILES["src/services/comments.js"] = """import { badRequest, notFound } from "../errors.js";

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
"""

FILES["src/services/search.js"] = """// Full-text-ish search over project names and task titles. Read-only.
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
"""

FILES["src/services/reports.js"] = """// Board statistics. summary() is computed live; rebuild() stores a snapshot
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
"""

FILES["src/services/exports.js"] = """// Project export (JSON download). Exports are audited because they contain
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
"""

# ---------------------------------------------------------------- routes
# (file name, method, path, one-line comment, handler expression)

ROUTES = [
    ("health", "GET", "/health", "Liveness probe for the load balancer.",
     '() => ({ status: 200, body: { ok: true } })'),
    ("version", "GET", "/version", "Build information.",
     '() => ({ status: 200, body: { name: "teamboard-api", version: "0.7.0" } })'),
    ("projects-list", "GET", "/projects", "Active projects (archived ones with ?all, see body.all).",
     '({ body, services }) => ({\n    status: 200,\n    body: services.projects.list({ includeArchived: body.all === true }),\n  })'),
    ("projects-get", "GET", "/projects/:id", "One project.",
     '({ params, services }) => ({ status: 200, body: services.projects.get(params.id) })'),
    ("projects-create", "POST", "/projects", "Create a project owned by the caller.",
     '({ body, auth, services }) => ({\n    status: 201,\n    body: services.projects.create({ name: body.name, ownerId: auth?.userId }),\n  })'),
    ("projects-rename", "PATCH", "/projects/:id", "Rename a project.",
     '({ params, body, services }) => ({\n    status: 200,\n    body: services.projects.rename(params.id, body.name),\n  })'),
    ("projects-archive", "POST", "/projects/:id/archive", "Archive a project (hidden from the board).",
     '({ params, services }) => ({ status: 200, body: services.projects.archive(params.id) })'),
    ("projects-export", "GET", "/projects/:id/export", "Download a project and its tasks as JSON.",
     '({ params, auth, services }) => ({\n    status: 200,\n    body: services.exports.exportProject(params.id, auth?.userId ?? "anonymous"),\n  })'),
    ("project-tasks-list", "GET", "/projects/:id/tasks", "Tasks of a project.",
     '({ params, services }) => ({ status: 200, body: services.projects.tasks(params.id) })'),
    ("project-tasks-create", "POST", "/projects/:id/tasks", "Add a task to a project.",
     '({ params, body, services }) => ({\n    status: 201,\n    body: services.tasks.create(params.id, { title: body.title }),\n  })'),
    ("tasks-get", "GET", "/tasks/:id", "One task.",
     '({ params, services }) => ({ status: 200, body: services.tasks.get(params.id) })'),
    ("tasks-update", "PATCH", "/tasks/:id", "Edit a task's title or done flag.",
     '({ params, body, services }) => ({ status: 200, body: services.tasks.update(params.id, body) })'),
    ("tasks-complete", "POST", "/tasks/:id/complete", "Mark a task done.",
     '({ params, services }) => ({ status: 200, body: services.tasks.complete(params.id) })'),
    ("tasks-delete", "DELETE", "/tasks/:id", "Delete a task and its comments.",
     '({ params, services }) => {\n    services.tasks.remove(params.id);\n    return { status: 204, body: null };\n  }'),
    ("tasks-tag", "POST", "/tasks/:id/tags", "Tag a task (body.tag), creating the tag if new.",
     '({ params, body, services }) => ({ status: 200, body: services.tasks.addTag(params.id, body.tag) })'),
    ("comments-list", "GET", "/tasks/:id/comments", "Comments on a task, with author names.",
     '({ params, services }) => ({ status: 200, body: services.comments.listForTask(params.id) })'),
    ("comments-create", "POST", "/tasks/:id/comments", "Comment on a task as the caller.",
     '({ params, body, auth, services }) => ({\n    status: 201,\n    body: services.comments.add(params.id, auth?.userId, body.text),\n  })'),
    ("comments-delete", "DELETE", "/comments/:id", "Delete a comment.",
     '({ params, services }) => {\n    services.comments.remove(params.id);\n    return { status: 204, body: null };\n  }'),
    ("tags-list", "GET", "/tags", "All tags.",
     '({ services }) => ({ status: 200, body: services.tags.list() })'),
    ("tags-create", "POST", "/tags", "Create a tag.",
     '({ body, services }) => ({ status: 201, body: services.tags.create(body.name) })'),
    ("users-get", "GET", "/users/:id", "A user's public profile.",
     '({ params, services }) => {\n    const { id, name, role } = services.users.get(params.id);\n    return { status: 200, body: { id, name, role } };\n  }'),
    ("users-update", "PATCH", "/users/:id", "Update a user's name or e-mail.",
     '({ params, body, services }) => ({\n    status: 200,\n    body: services.users.updateProfile(params.id, body),\n  })'),
    ("sessions-current", "GET", "/sessions/current", "The caller's session.",
     '({ auth, services }) => ({ status: 200, body: services.sessions.current(auth?.userId) })'),
    ("search", "POST", "/search", "Search projects and tasks (body.query). POST because queries can be long.",
     '({ body, services }) => ({ status: 200, body: services.search.search(body.query) })'),
    ("reports-summary", "GET", "/reports/summary", "Live board statistics.",
     '({ services }) => ({ status: 200, body: services.reports.summary() })'),
    ("reports-rebuild", "POST", "/reports/rebuild", "Recompute the stored weekly report.",
     '({ services }) => ({ status: 200, body: services.reports.rebuild() })'),
    ("admin-users-list", "GET", "/admin/users", "Every user, with e-mail addresses.",
     '({ services }) => ({ status: 200, body: services.users.list() })'),
    ("admin-users-delete", "DELETE", "/admin/users/:id", "Delete a user and end their sessions.",
     '({ params, services }) => {\n    services.users.remove(params.id);\n    return { status: 204, body: null };\n  }'),
    ("admin-audit", "GET", "/admin/audit", "The audit trail.",
     '({ services }) => ({ status: 200, body: services.audit.list() })'),
    ("admin-projects-restore", "POST", "/admin/projects/:id/restore", "Bring an archived project back.",
     '({ params, services }) => ({ status: 200, body: services.projects.restore(params.id) })'),
]


def camel(name):
    head, *rest = name.split("-")
    return head + "".join(p.capitalize() for p in rest)


def route_file(method, path, comment, handler):
    return (
        f"// {method} {path}\n"
        f"// {comment}\n"
        "export default {\n"
        f'  method: "{method}",\n'
        f'  path: "{path}",\n'
        f"  handler: {handler},\n"
        "};\n"
    )


for fname, method, path, comment, handler in ROUTES:
    FILES[f"src/routes/{fname}.js"] = route_file(method, path, comment, handler)

FILES["src/routes/index.js"] = (
    "".join(f'import {camel(f)} from "./{f}.js";\n' for f, *_ in ROUTES)
    + "\nexport const routes = [\n"
    + "".join(f"  {camel(f)},\n" for f, *_ in ROUTES)
    + "];\n"
)

FILES["test/api.test.js"] = """import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.js";

const ADMIN = { userId: "u1", scopes: ["admin"] };

function call(app, method, path, body) {
  return app.handle({ method, path, body, auth: ADMIN });
}

test("health is up", () => {
  const app = createApp();
  assert.deepEqual(app.handle({ method: "GET", path: "/health" }), { status: 200, body: { ok: true } });
});

test("unknown route is 404", () => {
  const app = createApp();
  assert.equal(call(app, "GET", "/nope").status, 404);
});

test("projects: list, create, rename, archive", () => {
  const app = createApp();
  assert.deepEqual(call(app, "GET", "/projects").body.map((p) => p.id), ["p1", "p2"]);
  const created = call(app, "POST", "/projects", { name: " Docs " });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, "Docs");
  assert.equal(created.body.ownerId, "u1");
  assert.equal(call(app, "PATCH", "/projects/p2", { name: "App" }).body.name, "App");
  call(app, "POST", "/projects/p1/archive");
  assert.deepEqual(call(app, "GET", "/projects").body.map((p) => p.id), ["p2", created.body.id]);
  assert.equal(call(app, "GET", "/projects/p9").status, 404);
});

test("tasks and comments", () => {
  const app = createApp();
  const task = call(app, "POST", "/projects/p1/tasks", { title: "Write docs" }).body;
  call(app, "POST", `/tasks/${task.id}/complete`);
  assert.equal(call(app, "GET", `/tasks/${task.id}`).body.done, true);
  call(app, "POST", "/tasks/t1/comments", { text: "On it" });
  assert.deepEqual(
    call(app, "GET", "/tasks/t1/comments").body.map((c) => c.author),
    ["Bo", "Ada", "Ada"],
  );
  assert.equal(call(app, "DELETE", "/tasks/t1").status, 204);
  assert.equal(call(app, "GET", "/tasks/t1").status, 404);
});

test("tags", () => {
  const app = createApp();
  call(app, "POST", "/tasks/t2/tags", { tag: "urgent" });
  assert.deepEqual(call(app, "GET", "/tags").body.map((t) => t.name), ["bug", "feature", "urgent"]);
  assert.equal(call(app, "POST", "/tags", { name: "Bad Tag" }).status, 400);
});

test("search and reports", () => {
  const app = createApp();
  assert.deepEqual(call(app, "POST", "/search", { query: "page" }).body, { projects: [], tasks: ["t2"] });
  assert.deepEqual(call(app, "GET", "/reports/summary").body, {
    projects: 2,
    openTasks: 2,
    doneTasks: 1,
    comments: 2,
  });
});

test("export is audited", () => {
  const app = createApp();
  assert.equal(call(app, "GET", "/projects/p1/export").body.tasks.length, 2);
  assert.deepEqual(
    call(app, "GET", "/admin/audit").body.map((a) => [a.actorId, a.action, a.target]),
    [["u1", "export", "p1"]],
  );
});
"""


# ---------------------------------------------------------------- reference solution
# Scope per route file, decided by reading the code (and cross-checked against
# behaviour by _tools/check_long_context_table.mjs, which uses check/routes.table.js).
SCOPES = {
    "health": "public", "version": "public",
    "projects-list": "read", "projects-get": "read", "project-tasks-list": "read",
    "tasks-get": "read", "comments-list": "read", "tags-list": "read", "users-get": "read",
    "search": "read", "reports-summary": "read",
    "projects-create": "write", "projects-rename": "write", "projects-archive": "write",
    "projects-export": "write", "project-tasks-create": "write", "tasks-update": "write",
    "tasks-complete": "write", "tasks-delete": "write", "tasks-tag": "write",
    "comments-create": "write", "comments-delete": "write", "tags-create": "write",
    "users-update": "write", "sessions-current": "write", "reports-rebuild": "write",
    "admin-users-list": "admin", "admin-users-delete": "admin", "admin-audit": "admin",
    "admin-projects-restore": "admin",
}

SOLUTION = os.path.join(os.path.dirname(HERE), "long-context-many-files", "solution")

SOLUTION_APP = """import { createDb } from "./db.js";
import { HttpError } from "./errors.js";
import { createRouter } from "./router.js";
import { routes } from "./routes/index.js";
import { SEED } from "./seed.js";
import { createServices } from "./services/index.js";

// Scopes are ordered; a granted scope allows everything a lower one does.
const RANK = { read: 1, write: 2, admin: 3 };

for (const route of routes) {
  if (route.scope !== "public" && !(route.scope in RANK)) {
    throw new Error(`route ${route.method} ${route.path} has no valid scope`);
  }
}

function grantedRank(auth) {
  const scopes = Array.isArray(auth.scopes) ? auth.scopes : [];
  return Math.max(0, ...scopes.map((s) => RANK[s] ?? 0));
}

/**
 * @param {{ db?: ReturnType<typeof createDb> }} [options]
 */
export function createApp({ db = createDb(SEED) } = {}) {
  const services = createServices(db);
  const router = createRouter(routes);

  /**
   * @param {{ method: string, path: string, body?: any, auth?: { userId: string, scopes: string[] } }} request
   * @returns {{ status: number, body: any }}
   */
  function handle({ method, path, body = {}, auth }) {
    const found = router.match(method, path);
    if (!found) return { status: 404, body: { error: "not_found" } };
    const { scope } = found.route;
    if (scope !== "public") {
      if (!auth) return { status: 401, body: { error: "unauthenticated" } };
      if (grantedRank(auth) < RANK[scope]) {
        return { status: 403, body: { error: "forbidden", required: scope } };
      }
    }
    try {
      return found.route.handler({ params: found.params, body, auth, services, db });
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: { error: err.code } };
      throw err;
    }
  }

  return { handle, db };
}
"""

SOLUTION_TEST = """import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.js";

const as = (scopes) => ({ userId: "u1", scopes });

test("no auth is 401, public routes stay open", () => {
  const app = createApp();
  assert.equal(app.handle({ method: "GET", path: "/projects" }).status, 401);
  assert.equal(app.handle({ method: "GET", path: "/version" }).status, 200);
});

test("scope is decided by what the route does", () => {
  const app = createApp();
  const read = as(["read"]);
  assert.equal(app.handle({ method: "POST", path: "/search", body: { query: "x" }, auth: read }).status, 200);
  assert.deepEqual(app.handle({ method: "GET", path: "/projects/p1/export", auth: read }).body, {
    error: "forbidden",
    required: "write",
  });
  assert.equal(app.handle({ method: "GET", path: "/sessions/current", auth: read }).status, 403);
  assert.equal(app.handle({ method: "GET", path: "/admin/users", auth: as(["write"]) }).status, 403);
  assert.equal(app.handle({ method: "GET", path: "/admin/users", auth: as(["admin"]) }).status, 200);
});
"""


def write_tree(root, files):
    for rel, text in files.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text)


def main():
    write_tree(FIXTURE, FILES)
    solution = {"src/app.js": SOLUTION_APP, "test/permissions.test.js": SOLUTION_TEST}
    for fname, method, path, comment, handler in ROUTES:
        text = route_file(method, path, comment, handler)
        solution[f"src/routes/{fname}.js"] = text.replace(
            f'  path: "{path}",\n', f'  path: "{path}",\n  scope: "{SCOPES[fname]}",\n'
        )
    solution["docs/permissions.md"] = FILES["docs/permissions.md"].replace(
        "Status: agreed, **not implemented yet**. Today every route is open.",
        "Status: implemented. Each route file declares its `scope`; `src/app.js` enforces it.",
    )
    write_tree(SOLUTION, solution)
    print(f"wrote {len(FILES)} fixture files ({len(ROUTES)} routes) and {len(solution)} solution files")


if __name__ == "__main__":
    main()
