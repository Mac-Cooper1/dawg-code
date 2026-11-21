// GET /users/:id
// A user's public profile.
export default {
  method: "GET",
  path: "/users/:id",
  scope: "read",
  handler: ({ params, services }) => {
    const { id, name, role } = services.users.get(params.id);
    return { status: 200, body: { id, name, role } };
  },
};
