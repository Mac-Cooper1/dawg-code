// POST /reports/rebuild
// Recompute the stored weekly report.
export default {
  method: "POST",
  path: "/reports/rebuild",
  handler: ({ services }) => ({ status: 200, body: services.reports.rebuild() }),
};
