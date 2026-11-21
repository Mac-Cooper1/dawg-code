// POST /projects
// Create a project owned by the caller.
export default {
  method: "POST",
  path: "/projects",
  scope: "write",
  handler: ({ body, auth, services }) => ({
    status: 201,
    body: services.projects.create({ name: body.name, ownerId: auth?.userId }),
  }),
};
