// GET /admin/users
// Every user, with e-mail addresses.
export default {
  method: "GET",
  path: "/admin/users",
  scope: "admin",
  handler: ({ services }) => ({ status: 200, body: services.users.list() }),
};
