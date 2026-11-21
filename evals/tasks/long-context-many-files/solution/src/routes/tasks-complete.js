// POST /tasks/:id/complete
// Mark a task done.
export default {
  method: "POST",
  path: "/tasks/:id/complete",
  scope: "write",
  handler: ({ params, services }) => ({ status: 200, body: services.tasks.complete(params.id) }),
};
