// GET /version
// Build information.
export default {
  method: "GET",
  path: "/version",
  handler: () => ({ status: 200, body: { name: "teamboard-api", version: "0.7.0" } }),
};
