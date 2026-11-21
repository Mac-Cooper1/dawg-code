// GET /sessions/current
// The caller's session.
export default {
  method: "GET",
  path: "/sessions/current",
  scope: "write",
  handler: ({ auth, services }) => ({ status: 200, body: services.sessions.current(auth?.userId) }),
};
