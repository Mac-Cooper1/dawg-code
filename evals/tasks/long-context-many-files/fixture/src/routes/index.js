import health from "./health.js";
import version from "./version.js";
import projectsList from "./projects-list.js";
import projectsGet from "./projects-get.js";
import projectsCreate from "./projects-create.js";
import projectsRename from "./projects-rename.js";
import projectsArchive from "./projects-archive.js";
import projectsExport from "./projects-export.js";
import projectTasksList from "./project-tasks-list.js";
import projectTasksCreate from "./project-tasks-create.js";
import tasksGet from "./tasks-get.js";
import tasksUpdate from "./tasks-update.js";
import tasksComplete from "./tasks-complete.js";
import tasksDelete from "./tasks-delete.js";
import tasksTag from "./tasks-tag.js";
import commentsList from "./comments-list.js";
import commentsCreate from "./comments-create.js";
import commentsDelete from "./comments-delete.js";
import tagsList from "./tags-list.js";
import tagsCreate from "./tags-create.js";
import usersGet from "./users-get.js";
import usersUpdate from "./users-update.js";
import sessionsCurrent from "./sessions-current.js";
import search from "./search.js";
import reportsSummary from "./reports-summary.js";
import reportsRebuild from "./reports-rebuild.js";
import adminUsersList from "./admin-users-list.js";
import adminUsersDelete from "./admin-users-delete.js";
import adminAudit from "./admin-audit.js";
import adminProjectsRestore from "./admin-projects-restore.js";

export const routes = [
  health,
  version,
  projectsList,
  projectsGet,
  projectsCreate,
  projectsRename,
  projectsArchive,
  projectsExport,
  projectTasksList,
  projectTasksCreate,
  tasksGet,
  tasksUpdate,
  tasksComplete,
  tasksDelete,
  tasksTag,
  commentsList,
  commentsCreate,
  commentsDelete,
  tagsList,
  tagsCreate,
  usersGet,
  usersUpdate,
  sessionsCurrent,
  search,
  reportsSummary,
  reportsRebuild,
  adminUsersList,
  adminUsersDelete,
  adminAudit,
  adminProjectsRestore,
];
