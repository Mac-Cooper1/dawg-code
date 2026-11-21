// GET /admin/audit
// The audit trail.
export default {
  method: "GET",
  path: "/admin/audit",
  handler: ({ services }) => ({ status: 200, body: services.audit.list() }),
};
