// DELETE /tasks/:id
// Delete a task and its comments.
export default {
  method: "DELETE",
  path: "/tasks/:id",
  scope: "write",
  handler: ({ params, services }) => {
    services.tasks.remove(params.id);
    return { status: 204, body: null };
  },
};
