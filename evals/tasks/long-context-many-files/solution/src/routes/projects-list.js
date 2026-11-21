// GET /projects
// Active projects (archived ones with ?all, see body.all).
export default {
  method: "GET",
  path: "/projects",
  scope: "read",
  handler: ({ body, services }) => ({
    status: 200,
    body: services.projects.list({ includeArchived: body.all === true }),
  }),
};
