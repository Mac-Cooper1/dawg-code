// Every route with a request that succeeds on fresh seed data, and the scope
// docs/permissions.md requires for it ("public" = no auth needed).
export const ROUTES = [
  { method: "GET", path: "/health", scope: "public" },
  { method: "GET", path: "/version", scope: "public" },
  { method: "GET", path: "/projects", scope: "read" },
  { method: "GET", path: "/projects/p1", scope: "read" },
  { method: "POST", path: "/projects", body: { name: "Docs" }, scope: "write" },
  { method: "PATCH", path: "/projects/p2", body: { name: "App" }, scope: "write" },
  { method: "POST", path: "/projects/p2/archive", scope: "write" },
  // GET, but the export service writes an audit entry.
  { method: "GET", path: "/projects/p1/export", scope: "write" },
  { method: "GET", path: "/projects/p1/tasks", scope: "read" },
  { method: "POST", path: "/projects/p1/tasks", body: { title: "Write docs" }, scope: "write" },
  { method: "GET", path: "/tasks/t1", scope: "read" },
  { method: "PATCH", path: "/tasks/t1", body: { title: "Fix the header" }, scope: "write" },
  { method: "POST", path: "/tasks/t2/complete", scope: "write" },
  { method: "DELETE", path: "/tasks/t2", scope: "write" },
  { method: "POST", path: "/tasks/t1/tags", body: { tag: "urgent" }, scope: "write" },
  { method: "GET", path: "/tasks/t1/comments", scope: "read" },
  { method: "POST", path: "/tasks/t1/comments", body: { text: "On it" }, scope: "write" },
  { method: "DELETE", path: "/comments/c1", scope: "write" },
  { method: "GET", path: "/tags", scope: "read" },
  { method: "POST", path: "/tags", body: { name: "docs" }, scope: "write" },
  { method: "GET", path: "/users/u2", scope: "read" },
  { method: "PATCH", path: "/users/u2", body: { name: "Bob" }, scope: "write" },
  // GET, but it updates the session's lastSeen.
  { method: "GET", path: "/sessions/current", scope: "write" },
  // POST, but read-only.
  { method: "POST", path: "/search", body: { query: "page" }, scope: "read" },
  { method: "GET", path: "/reports/summary", scope: "read" },
  { method: "POST", path: "/reports/rebuild", scope: "write" },
  { method: "GET", path: "/admin/users", scope: "admin" },
  { method: "DELETE", path: "/admin/users/u3", scope: "admin" },
  { method: "GET", path: "/admin/audit", scope: "admin" },
  { method: "POST", path: "/admin/projects/p3/restore", scope: "admin" },
];
