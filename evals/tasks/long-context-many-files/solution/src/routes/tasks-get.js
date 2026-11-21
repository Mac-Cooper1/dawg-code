// GET /tasks/:id
// One task.
export default {
  method: "GET",
  path: "/tasks/:id",
  scope: "read",
  handler: ({ params, services }) => ({ status: 200, body: services.tasks.get(params.id) }),
};
