// GET /projects/:id/export
// Download a project and its tasks as JSON.
export default {
  method: "GET",
  path: "/projects/:id/export",
  scope: "write",
  handler: ({ params, auth, services }) => ({
    status: 200,
    body: services.exports.exportProject(params.id, auth?.userId ?? "anonymous"),
  }),
};
