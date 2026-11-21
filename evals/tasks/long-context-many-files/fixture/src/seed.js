export const SEED = {
  users: [
    { id: "u1", name: "Ada", email: "ada@example.test", role: "lead" },
    { id: "u2", name: "Bo", email: "bo@example.test", role: "member" },
    { id: "u3", name: "Cy", email: "cy@example.test", role: "member" },
  ],
  projects: [
    { id: "p1", name: "Website", ownerId: "u1", archived: false },
    { id: "p2", name: "Mobile app", ownerId: "u2", archived: false },
    { id: "p3", name: "Old intranet", ownerId: "u1", archived: true },
  ],
  tasks: [
    { id: "t1", projectId: "p1", title: "Fix header", done: false, tags: ["bug"] },
    { id: "t2", projectId: "p1", title: "New pricing page", done: false, tags: [] },
    { id: "t3", projectId: "p2", title: "Offline mode", done: true, tags: ["feature"] },
  ],
  comments: [
    { id: "c1", taskId: "t1", authorId: "u2", text: "Only on Safari?" },
    { id: "c2", taskId: "t1", authorId: "u1", text: "Yes, 17.2 and up." },
  ],
  tags: [
    { id: "g1", name: "bug" },
    { id: "g2", name: "feature" },
  ],
  sessions: [
    { id: "s1", userId: "u1", lastSeen: 0 },
    { id: "s2", userId: "u2", lastSeen: 0 },
    { id: "s3", userId: "u3", lastSeen: 0 },
  ],
  audit: [],
  reports: [],
};
