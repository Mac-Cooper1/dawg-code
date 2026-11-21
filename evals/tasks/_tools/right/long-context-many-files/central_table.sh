# Alternative: a central scope table in a new module, route files untouched.
cat > src/permissions.js <<'JS'
const RANK = { read: 1, write: 2, admin: 3 };
const PUBLIC = new Set(["GET /health", "GET /version"]);
const WRITE = new Set([
  "POST /projects", "PATCH /projects/:id", "POST /projects/:id/archive", "GET /projects/:id/export",
  "POST /projects/:id/tasks", "PATCH /tasks/:id", "POST /tasks/:id/complete", "DELETE /tasks/:id",
  "POST /tasks/:id/tags", "POST /tasks/:id/comments", "DELETE /comments/:id", "POST /tags",
  "PATCH /users/:id", "GET /sessions/current", "POST /reports/rebuild",
]);
export function requiredScope(route) {
  const key = `${route.method} ${route.path}`;
  if (PUBLIC.has(key)) return null;
  if (route.path.startsWith("/admin/")) return "admin";
  return WRITE.has(key) ? "write" : "read";
}
export function authorize(route, auth) {
  const needed = requiredScope(route);
  if (!needed) return null;
  if (!auth) return { status: 401, body: { error: "unauthenticated" } };
  const have = Math.max(0, ...(auth.scopes || []).map((s) => RANK[s] || 0));
  return have >= RANK[needed] ? null : { status: 403, body: { error: "forbidden", required: needed } };
}
JS
python3 "$TASK_DIR/../_tools/replace.py" src/app.js 'import { createServices } from "./services/index.js";' 'import { createServices } from "./services/index.js";
import { authorize } from "./permissions.js";'
python3 "$TASK_DIR/../_tools/replace.py" src/app.js '    if (!found) return { status: 404, body: { error: "not_found" } };' '    if (!found) return { status: 404, body: { error: "not_found" } };
    const denied = authorize(found.route, auth);
    if (denied) return denied;'
