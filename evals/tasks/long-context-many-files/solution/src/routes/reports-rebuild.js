// POST /reports/rebuild
// Recompute the stored weekly report.
export default {
  method: "POST",
  path: "/reports/rebuild",
  scope: "write",
  handler: ({ services }) => ({ status: 200, body: services.reports.rebuild() }),
};
