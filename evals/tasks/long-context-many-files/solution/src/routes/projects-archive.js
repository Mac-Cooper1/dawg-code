// POST /projects/:id/archive
// Archive a project (hidden from the board).
export default {
  method: "POST",
  path: "/projects/:id/archive",
  scope: "write",
  handler: ({ params, services }) => ({ status: 200, body: services.projects.archive(params.id) }),
};
