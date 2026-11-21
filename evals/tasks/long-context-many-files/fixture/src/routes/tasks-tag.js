// POST /tasks/:id/tags
// Tag a task (body.tag), creating the tag if new.
export default {
  method: "POST",
  path: "/tasks/:id/tags",
  handler: ({ params, body, services }) => ({ status: 200, body: services.tasks.addTag(params.id, body.tag) }),
};
