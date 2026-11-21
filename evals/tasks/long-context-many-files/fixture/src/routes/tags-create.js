// POST /tags
// Create a tag.
export default {
  method: "POST",
  path: "/tags",
  handler: ({ body, services }) => ({ status: 201, body: services.tags.create(body.name) }),
};
