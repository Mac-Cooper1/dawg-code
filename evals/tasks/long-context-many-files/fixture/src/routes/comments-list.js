// GET /tasks/:id/comments
// Comments on a task, with author names.
export default {
  method: "GET",
  path: "/tasks/:id/comments",
  handler: ({ params, services }) => ({ status: 200, body: services.comments.listForTask(params.id) }),
};
