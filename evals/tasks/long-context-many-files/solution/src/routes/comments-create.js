// POST /tasks/:id/comments
// Comment on a task as the caller.
export default {
  method: "POST",
  path: "/tasks/:id/comments",
  scope: "write",
  handler: ({ params, body, auth, services }) => ({
    status: 201,
    body: services.comments.add(params.id, auth?.userId, body.text),
  }),
};
