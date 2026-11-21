// PATCH /projects/:id
// Rename a project.
export default {
  method: "PATCH",
  path: "/projects/:id",
  handler: ({ params, body, services }) => ({
    status: 200,
    body: services.projects.rename(params.id, body.name),
  }),
};
