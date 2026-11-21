// DELETE /admin/users/:id
// Delete a user and end their sessions.
export default {
  method: "DELETE",
  path: "/admin/users/:id",
  scope: "admin",
  handler: ({ params, services }) => {
    services.users.remove(params.id);
    return { status: 204, body: null };
  },
};
