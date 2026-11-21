// DELETE /comments/:id
// Delete a comment.
export default {
  method: "DELETE",
  path: "/comments/:id",
  scope: "write",
  handler: ({ params, services }) => {
    services.comments.remove(params.id);
    return { status: 204, body: null };
  },
};
