// GET /health
// Liveness probe for the load balancer.
export default {
  method: "GET",
  path: "/health",
  scope: "public",
  handler: () => ({ status: 200, body: { ok: true } }),
};
