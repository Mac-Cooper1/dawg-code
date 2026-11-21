// GET /tags
// All tags.
export default {
  method: "GET",
  path: "/tags",
  scope: "read",
  handler: ({ services }) => ({ status: 200, body: services.tags.list() }),
};
