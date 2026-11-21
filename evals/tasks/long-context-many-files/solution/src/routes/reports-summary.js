// GET /reports/summary
// Live board statistics.
export default {
  method: "GET",
  path: "/reports/summary",
  scope: "read",
  handler: ({ services }) => ({ status: 200, body: services.reports.summary() }),
};
