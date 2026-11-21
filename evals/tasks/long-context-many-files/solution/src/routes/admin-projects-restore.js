// POST /admin/projects/:id/restore
// Bring an archived project back.
export default {
  method: "POST",
  path: "/admin/projects/:id/restore",
  scope: "admin",
  handler: ({ params, services }) => ({ status: 200, body: services.projects.restore(params.id) }),
};
