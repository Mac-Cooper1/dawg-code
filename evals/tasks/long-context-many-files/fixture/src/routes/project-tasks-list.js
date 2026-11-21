// GET /projects/:id/tasks
// Tasks of a project.
export default {
  method: "GET",
  path: "/projects/:id/tasks",
  handler: ({ params, services }) => ({ status: 200, body: services.projects.tasks(params.id) }),
};
