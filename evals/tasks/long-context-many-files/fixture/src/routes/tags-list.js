// GET /tags
// All tags.
export default {
  method: "GET",
  path: "/tags",
  handler: ({ services }) => ({ status: 200, body: services.tags.list() }),
};
