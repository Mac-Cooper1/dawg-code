import assert from "node:assert/strict";
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
