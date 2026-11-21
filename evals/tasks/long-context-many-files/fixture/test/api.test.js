import assert from "node:assert/strict";
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
