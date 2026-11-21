// PATCH /users/:id
// Update a user's name or e-mail.
export default {
  method: "PATCH",
  path: "/users/:id",
  handler: ({ params, body, services }) => ({
    status: 200,
    body: services.users.updateProfile(params.id, body),
  }),
};
