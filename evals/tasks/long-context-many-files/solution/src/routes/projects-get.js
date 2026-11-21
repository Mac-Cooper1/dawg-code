// GET /projects/:id
// One project.
export default {
  method: "GET",
  path: "/projects/:id",
  scope: "read",
  handler: ({ params, services }) => ({ status: 200, body: services.projects.get(params.id) }),
};
