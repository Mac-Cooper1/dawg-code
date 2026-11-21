import { createAuditService } from "./audit.js";
import { createCommentService } from "./comments.js";
import { createExportService } from "./exports.js";
import { createProjectService } from "./projects.js";
import { createReportService } from "./reports.js";
import { createSearchService } from "./search.js";
import { createSessionService } from "./sessions.js";
import { createTagService } from "./tags.js";
import { createTaskService } from "./tasks.js";
import { createUserService } from "./users.js";

export function createServices(db) {
  const audit = createAuditService(db);
  const sessions = createSessionService(db);
  const users = createUserService(db, { sessions });
  const tags = createTagService(db);
  const projects = createProjectService(db);
  const tasks = createTaskService(db, { projects, tags });
  const comments = createCommentService(db, { users, tasks });
  const search = createSearchService(db);
  const reports = createReportService(db);
  const exports = createExportService(db, { projects, audit });
  return { audit, sessions, users, tags, projects, tasks, comments, search, reports, exports };
}
