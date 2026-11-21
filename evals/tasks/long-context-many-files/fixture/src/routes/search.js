// POST /search
// Search projects and tasks (body.query). POST because queries can be long.
export default {
  method: "POST",
  path: "/search",
  handler: ({ body, services }) => ({ status: 200, body: services.search.search(body.query) }),
};
