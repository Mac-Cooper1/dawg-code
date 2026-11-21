// POST /projects/:id/tasks
// Add a task to a project.
export default {
  method: "POST",
  path: "/projects/:id/tasks",
  handler: ({ params, body, services }) => ({
    status: 201,
    body: services.tasks.create(params.id, { title: body.title }),
  }),
};
