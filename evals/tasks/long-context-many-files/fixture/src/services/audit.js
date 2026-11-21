// Audit trail of sensitive actions.
export function createAuditService(db) {
  return {
    record(actorId, action, target) {
      return db.insert("audit", { actorId, action, target, at: db.tick() });
    },
    list() {
      return db.list("audit");
    },
  };
}
