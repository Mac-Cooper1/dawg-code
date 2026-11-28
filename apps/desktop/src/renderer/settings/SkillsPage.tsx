/**
 * Settings → Skills and commands: every skill (`skills/<name>/SKILL.md`) and custom command
 * (`commands/**\/*.md`) a project's sessions get, from the person's folders and the project's,
 * Claude Code's and dawg's: its name and description, its file, whether a person can run it with
 * `/`, and what dawg does with fields it maps or ignores. Read-only: the files are the source.
 *
 * Sessions read these when they start, so a file added now appears in the next session.
 */
import type { CompatItemStatus, SkillInfo } from "@dawg/protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { basename, shortenPath } from "../lib/format.ts";
import { sourceLabel } from "../lib/hooks.ts";
import type { SkillsListing } from "../state/types.ts";
import { Button, Icon, IconButton, Tag, type TagTone } from "../ui/index.ts";
import type { PermissionsProject } from "./PermissionsPage.tsx";
import settingsStyles from "./Settings.module.css";
import styles from "./SkillsPage.module.css";

/** What a status means for a skill or command, in a few words; nothing for one that works. */
const STATUS: Partial<Record<CompatItemStatus, { label: string; tone: TagTone }>> = {
  "partly-supported": { label: "Partly supported", tone: "amber" },
  "not-supported": { label: "Not supported yet", tone: "neutral" },
  invalid: { label: "Could not be loaded", tone: "red" },
};

export interface SkillsPageProps {
  /** The projects in the sidebar, in its order. */
  projects: readonly PermissionsProject[];
  /** The project shown first (the selected session's), or null for only the person's own. */
  initialProject: string | null;
  homeDir: string;
  listSkills(projectDir: string | null): Promise<SkillsListing | { error: string }>;
  /** Opens a skill or command file in the person's editor; absent, no "Open file" buttons. */
  onOpenFile?(path: string): void;
}

/** Who may start it, in one sentence. */
export function whoRuns(info: SkillInfo): string {
  const notUsed =
    info.status === "invalid" || info.notes.some((note) => note.startsWith("Not used"));
  if (notUsed) return "Not used.";
  const typed = `/${info.name}`;
  if (info.userInvocable && info.modelInvocable) {
    return `You run it with ${typed}; the agent loads it when a task fits.`;
  }
  if (info.userInvocable) return `Only you start it, with ${typed}.`;
  if (info.modelInvocable) return "Only the agent loads it; it is not in the / menu.";
  return "Neither you nor the agent can start it.";
}

export function SkillsPage(props: SkillsPageProps) {
  const { homeDir, listSkills } = props;
  const projectId = useId();
  const [picked, setPicked] = useState(false);
  const [projectDir, setProjectDir] = useState<string | null>(props.initialProject);
  const [listing, setListing] = useState<SkillsListing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = useRef<string | null>(projectDir);
  shown.current = projectDir;

  // Until the person picks a project, follow the selected session's (the store may still load).
  useEffect(() => {
    if (!picked) setProjectDir(props.initialProject);
  }, [picked, props.initialProject]);

  const load = useCallback(
    async (dir: string | null) => {
      const result = await listSkills(dir);
      if (shown.current !== dir) return;
      if ("error" in result) {
        setProblem(`Could not list the skills and commands: ${result.error}`);
        return;
      }
      setProblem(null);
      setListing(result);
    },
    [listSkills],
  );

  useEffect(() => {
    void load(projectDir);
  }, [load, projectDir]);

  // Files added or edited elsewhere show when the window comes back.
  useEffect(() => {
    const refresh = () => void load(shown.current);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);

  const loaded = listing !== null && listing.projectDir === projectDir;
  const projectChoices =
    projectDir !== null && !props.projects.some((p) => p.dir === projectDir)
      ? [{ dir: projectDir, name: basename(projectDir) }, ...props.projects]
      : props.projects;

  return (
    <div className={styles.page}>
      <h1 className={settingsStyles.h1}>Skills and commands</h1>
      <p className={settingsStyles.lead}>
        Skills and custom slash commands from your home folder and the project, read as Claude Code
        reads them. Sessions read them when they start, so a new one appears in the next session.
      </p>

      {problem !== null && (
        <p className={styles.notice} role="alert">
          <Icon name="alert" size={14} />
          <span className={styles.noticeText}>{problem}</span>
          <IconButton icon="close" size="sm" label="Dismiss" onClick={() => setProblem(null)} />
        </p>
      )}

      <div className={styles.projectRow}>
        <label className={styles.fieldLabel} htmlFor={projectId}>
          Project
        </label>
        <select
          id={projectId}
          className={styles.select}
          value={projectDir ?? ""}
          onChange={(event) => {
            setPicked(true);
            setProjectDir(event.target.value === "" ? null : event.target.value);
          }}
        >
          {projectChoices.map((project) => (
            <option key={project.dir} value={project.dir}>
              {project.name} ({shortenPath(project.dir, homeDir)})
            </option>
          ))}
          <option value="">No project: only yours</option>
        </select>
      </div>

      {!loaded ? (
        problem === null && (
          <p className={settingsStyles.note} aria-live="polite">
            Reading the skills and commands…
          </p>
        )
      ) : listing.skills.length === 0 && listing.commands.length === 0 ? (
        <div className={settingsStyles.empty}>
          <p className={settingsStyles.emptyTitle}>No skills or commands</p>
          <p className={settingsStyles.emptyText}>
            Put a skill in <code>~/.claude/skills/&lt;name&gt;/SKILL.md</code> for every project, or
            in <code>.claude/skills/&lt;name&gt;/SKILL.md</code> inside a project. A custom command
            is any <code>.md</code> file under <code>~/.claude/commands</code> or a project’s{" "}
            <code>.claude/commands</code>. The same folders under <code>.dawg</code> work too, and
            win over <code>.claude</code>.
          </p>
        </div>
      ) : (
        <>
          <SkillSection
            title="Skills"
            items={listing.skills}
            homeDir={homeDir}
            onOpenFile={props.onOpenFile}
          />
          <SkillSection
            title="Commands"
            items={listing.commands}
            homeDir={homeDir}
            onOpenFile={props.onOpenFile}
          />
        </>
      )}
    </div>
  );
}

function SkillSection(props: {
  title: string;
  items: readonly SkillInfo[];
  homeDir: string;
  onOpenFile: ((path: string) => void) | undefined;
}) {
  const headingId = useId();
  if (props.items.length === 0) return null;
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.h2}>
        {props.title}
        <span className={styles.count}>{props.items.length}</span>
      </h2>
      <ul className={styles.list} aria-labelledby={headingId}>
        {props.items.map((item) => (
          <SkillRow
            key={`${item.source.path}\u0000${item.name}`}
            item={item}
            homeDir={props.homeDir}
            onOpenFile={props.onOpenFile}
          />
        ))}
      </ul>
    </section>
  );
}

function SkillRow(props: {
  item: SkillInfo;
  homeDir: string;
  onOpenFile: ((path: string) => void) | undefined;
}) {
  const { item, onOpenFile } = props;
  const nameId = useId();
  const status = STATUS[item.status];
  const notUsed = item.notes.some((note) => note.startsWith("Not used"));
  return (
    <li
      className={
        notUsed || item.status === "invalid" ? `${styles.row} ${styles.unused}` : styles.row
      }
    >
      <div className={styles.rowHead}>
        <span id={nameId} className={styles.name}>
          {item.userInvocable ? `/${item.name}` : item.name}
          {item.argumentHint !== null && item.userInvocable && (
            <span className={styles.hint}> {item.argumentHint}</span>
          )}
        </span>
        <Tag>
          {item.source.scope === "user"
            ? "Personal"
            : item.source.scope === "nested"
              ? "Folder"
              : "Project"}
        </Tag>
        {notUsed && <Tag>Not used</Tag>}
        {status !== undefined && <Tag tone={status.tone}>{status.label}</Tag>}
        {onOpenFile !== undefined && (
          <Button
            className={styles.open}
            size="sm"
            variant="ghost"
            icon="file"
            aria-describedby={nameId}
            onClick={() => onOpenFile(item.source.path)}
          >
            Open file
          </Button>
        )}
      </div>
      {item.description !== "" && <p className={styles.description}>{item.description}</p>}
      <p className={styles.meta}>
        <code className={styles.path}>{shortenPath(item.source.path, props.homeDir)}</code>
        <span> · {sourceLabel(item.source)}</span>
      </p>
      <p className={styles.meta}>{whoRuns(item)}</p>
      {item.notes.length > 0 && (
        <ul className={styles.notes} aria-label="Notes">
          {item.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </li>
  );
}
