// PATCH /tasks/:id
// Edit a task's title or done flag.
export default {
  method: "PATCH",
  path: "/tasks/:id",
  handler: ({ params, body, services }) => ({ status: 200, body: services.tasks.update(params.id, body) }),
};
