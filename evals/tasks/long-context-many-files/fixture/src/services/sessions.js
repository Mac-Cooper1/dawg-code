// Login sessions, one per user, maintained by the gateway.
export function createSessionService(db) {
  return {
    /** The caller's session. Also marks it as seen, for the "active now" list. */
    current(userId) {
      const [session] = db.find("sessions", (s) => s.userId === userId);
      if (!session) return null;
      return db.update("sessions", session.id, { lastSeen: db.tick() });
    },
    revokeAll(userId) {
      for (const s of db.find("sessions", (x) => x.userId === userId)) db.remove("sessions", s.id);
    },
  };
}
