// Consistency check for long-context-many-files: run every route in the hidden
// table against the ORIGINAL fixture (no permissions yet) with db writes
// instrumented, and confirm the table's scopes follow docs/permissions.md:
// "write" exactly when the request writes, "admin" exactly for /admin/ paths,
// every route listed once, and every sample request succeeds.
// Usage: node evals/tasks/_tools/check_long_context_table.mjs
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const task = join(dirname(fileURLToPath(import.meta.url)), "..", "long-context-many-files");
const imp = (p) => import(pathToFileURL(join(task, p)).href);
const { createApp } = await imp("fixture/src/app.js");
const { routes } = await imp("fixture/src/routes/index.js");
const { ROUTES } = await imp("check/routes.table.js");

let problems = 0;
const fail = (msg) => {
  problems += 1;
  console.log(`PROBLEM: ${msg}`);
};

const declared = new Set(routes.map((r) => `${r.method} ${r.path}`));
const covered = new Set();
for (const entry of ROUTES) {
  const app = createApp();
  let writes = 0;
  for (const m of ["insert", "update", "remove"]) {
    const original = app.db[m];
    app.db[m] = (...args) => {
      writes += 1;
      return original(...args);
    };
  }
  const res = app.handle({ method: entry.method, path: entry.path, body: entry.body ?? {}, auth: { userId: "u1", scopes: ["admin"] } });
  const label = `${entry.method} ${entry.path}`;
  const matched = routes.find((r) => r.method === entry.method && new RegExp(`^${r.path.replace(/:[a-zA-Z]+/g, "[^/]+")}$`).test(entry.path));
  if (!matched) fail(`${label}: matches no route`);
  else covered.add(`${matched.method} ${matched.path}`);
  if (res.status >= 300) fail(`${label}: sample request returned ${res.status}`);
  const isAdminPath = entry.path.startsWith("/admin/");
  const isPublic = ["GET /health", "GET /version"].includes(label);
  const expected = isPublic ? "public" : isAdminPath ? "admin" : writes > 0 ? "write" : "read";
  if (expected !== entry.scope) fail(`${label}: table says ${entry.scope}, behaviour says ${expected} (${writes} writes)`);
  console.log(`${entry.scope.padEnd(6)} ${label}  (writes: ${writes})`);
}
for (const r of declared) if (!covered.has(r)) fail(`route ${r} is not in the table`);
console.log(`${ROUTES.length} table entries, ${declared.size} routes, ${problems} problems`);
process.exitCode = problems ? 1 : 0;
