// Hidden tests for the permission model (docs/permissions.md).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ROUTES } from "./routes.table.js";

const { createApp } = await import(pathToFileURL(join(process.env.WORKSPACE, "src", "app.js")).href);

const RANK = { read: 1, write: 2, admin: 3 };
const SCOPE_SETS = [[], ["read"], ["write"], ["read", "write"], ["admin"], ["read", "admin"], ["superuser"]];
const rankOf = (scopes) => Math.max(0, ...scopes.map((s) => RANK[s] ?? 0));

function send(route, auth) {
  const app = createApp();
  const before = app.db.snapshot();
  const request = { method: route.method, path: route.path, body: structuredClone(route.body ?? {}) };
  if (auth) request.auth = auth;
  const res = app.handle(request);
  return { res, changed: app.db.snapshot() !== before };
}

for (const route of ROUTES) {
  const label = `${route.method} ${route.path}`;

  if (route.scope === "public") {
    test(`${label} is public`, () => {
      assert.equal(send(route).res.status, 200);
      assert.equal(send(route, { userId: "u1", scopes: [] }).res.status, 200);
    });
    continue;
  }

  test(`${label} without auth is 401 and changes nothing`, () => {
    const { res, changed } = send(route);
    assert.equal(res.status, 401);
    assert.equal(res.body?.error, "unauthenticated");
    assert.equal(changed, false, "a rejected request modified the database");
  });

  test(`${label} needs ${route.scope}`, () => {
    for (const scopes of SCOPE_SETS) {
      const { res, changed } = send(route, { userId: "u1", scopes });
      if (rankOf(scopes) >= RANK[route.scope]) {
        assert.ok(res.status < 300, `scopes ${JSON.stringify(scopes)}: expected success, got ${res.status}`);
      } else {
        assert.equal(res.status, 403, `scopes ${JSON.stringify(scopes)}: expected 403, got ${res.status}`);
        assert.equal(res.body?.error, "forbidden");
        assert.equal(res.body?.required, route.scope, `scopes ${JSON.stringify(scopes)}: wrong "required"`);
        assert.equal(changed, false, "a rejected request modified the database");
      }
    }
  });
}

test("unknown routes are 404 with or without auth", () => {
  const app = createApp();
  assert.equal(app.handle({ method: "GET", path: "/nope" }).status, 404);
  assert.equal(app.handle({ method: "GET", path: "/admin/nope", auth: { userId: "u1", scopes: [] } }).status, 404);
  assert.equal(app.handle({ method: "PUT", path: "/projects/p1", auth: { userId: "u1", scopes: ["admin"] } }).status, 404);
});

test("handlers still work when allowed", () => {
  const app = createApp();
  const admin = { userId: "u1", scopes: ["admin"] };
  const writer = { userId: "u2", scopes: ["write"] };
  const created = app.handle({ method: "POST", path: "/projects", body: { name: "Docs" }, auth: writer });
  assert.equal(created.status, 201);
  assert.equal(created.body.ownerId, "u2");
  app.handle({ method: "GET", path: "/projects/p1/export", auth: writer });
  const audit = app.handle({ method: "GET", path: "/admin/audit", auth: admin });
  assert.deepEqual(audit.body.map((a) => [a.actorId, a.action, a.target]), [["u2", "export", "p1"]]);
  const search = app.handle({ method: "POST", path: "/search", body: { query: "mobile" }, auth: { userId: "u3", scopes: ["read"] } });
  assert.deepEqual(search.body, { projects: ["p2"], tasks: [] });
});
