/**
 * Settings → Project setup: the compatibility report (Phase 4 spec, "Compatibility report") for a
 * project and the person's home folder. Everything a Claude Code setup holds (instruction files,
 * settings files, skills, commands, subagents, hooks, MCP servers and the rest), grouped by what
 * dawg does with it, each with its source file and notes. The consent the project's code has is
 * shown read-only; "Review…" opens the trust dialog, where it is given or taken back.
 */
import type { CodeApproval, CompatItem, CompatReport } from "@dawg/protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { basename, shortenPath } from "../lib/format.ts";
import { isSandboxHost } from "../lib/sandbox.ts";
import { Button, Icon, IconButton, Tag, type TagTone } from "../ui/index.ts";
import type { PermissionsProject } from "./PermissionsPage.tsx";
import styles from "./ProjectSetupPage.module.css";
import settingsStyles from "./Settings.module.css";

/** The report's sections, in the spec's order, with Invalid last. */
export const SECTIONS: readonly {
  status: CompatItem["status"];
  title: string;
  lead: string;
  tone: TagTone;
}[] = [
  { status: "loaded", title: "Loaded", lead: "Works as it does in Claude Code.", tone: "green" },
  {
    status: "needs-approval",
    title: "Needs approval",
    lead: "Code from the project's files. It runs only after you approve it.",
    tone: "amber",
  },
  {
    status: "partly-supported",
    title: "Partly supported",
    lead: "Loaded, but dawg ignores some of it. The notes say what.",
    tone: "amber",
  },
  {
    status: "not-supported",
    title: "Not supported",
    lead: "Not used by dawg, or not yet. The notes say why.",
    tone: "neutral",
  },
  {
    status: "invalid",
    title: "Invalid",
    lead: "Could not be read. The notes say what is wrong.",
    tone: "red",
  },
];

export const KIND_LABEL: Record<CompatItem["kind"], string> = {
  instructions: "Instructions",
  settings: "Settings",
  command: "Command",
  skill: "Skill",
  agent: "Subagent",
  hook: "Hook",
  "mcp-server": "MCP server",
  other: "Other",
};

const SCOPE_LABEL: Record<CompatItem["source"]["scope"], string> = {
  user: "Yours",
  project: "Project",
  local: "Yours, this project",
  nested: "Folder in the project",
  flags: "Command line",
};

/** How the definitions needing consent are counted: "2 hooks and 1 MCP server". */
function approvalCount(approval: CodeApproval): string {
  const hooks = approval.items.filter((item) => item.kind === "hook").length;
  const servers = approval.items.filter((item) => item.kind === "mcp-server").length;
  const hosts = approval.items.filter(isSandboxHost).length;
  const rest = approval.items.length - hooks - servers - hosts;
  const parts = [
    hooks > 0 && `${hooks} ${hooks === 1 ? "hook" : "hooks"}`,
    servers > 0 && `${servers} ${servers === 1 ? "MCP server" : "MCP servers"}`,
    hosts > 0 && `${hosts} ${hosts === 1 ? "network host" : "network hosts"}`,
    rest > 0 && `${rest} other ${rest === 1 ? "definition" : "definitions"}`,
  ].filter((part): part is string => typeof part === "string");
  if (parts.length === 0) return "No code";
  return parts.length === 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export interface ProjectSetupPageProps {
  /** The projects in the sidebar, in its order. */
  projects: readonly PermissionsProject[];
  /** The project shown first (the selected session's), or null for only the person's files. */
  initialProject: string | null;
  homeDir: string;
  /** The report (`project.inspect`); a failure comes back as a sentence. */
  inspect(projectDir: string | null): Promise<CompatReport | { error: string }>;
  /** Opens the project trust dialog. */
  onReview(projectDir: string): void;
}

export function ProjectSetupPage(props: ProjectSetupPageProps) {
  const { homeDir } = props;
  // The latest `inspect`, so a new function from each render does not read the setup again.
  const inspect = useRef(props.inspect);
  inspect.current = props.inspect;
  const projectId = useId();
  const [picked, setPicked] = useState(false);
  const [projectDir, setProjectDir] = useState<string | null>(props.initialProject);
  const [report, setReport] = useState<CompatReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useRef<string | null>(projectDir);
  shown.current = projectDir;

  // Until the person picks a project, follow the selected session's (the store may still load).
  useEffect(() => {
    if (!picked) setProjectDir(props.initialProject);
  }, [picked, props.initialProject]);

  const load = useCallback(async (dir: string | null) => {
    setBusy(true);
    const answer = await inspect.current(dir);
    if (shown.current !== dir) return;
    setBusy(false);
    if ("error" in answer) {
      setProblem(`Could not read the setup: ${answer.error}`);
      return;
    }
    setProblem(null);
    setReport(answer);
  }, []);

  useEffect(() => {
    void load(projectDir);
  }, [load, projectDir]);

  // Files edited elsewhere, and consent given in the dialog, show when the window comes back.
  useEffect(() => {
    const refresh = () => void load(shown.current);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);

  const loaded = report !== null && report.projectDir === projectDir;
  const projectChoices =
    projectDir !== null && !props.projects.some((p) => p.dir === projectDir)
      ? [{ dir: projectDir, name: basename(projectDir) }, ...props.projects]
      : props.projects;

  return (
    <div className={styles.page}>
      <h1 className={settingsStyles.h1}>Project setup</h1>
      <p className={settingsStyles.lead}>
        What dawg found in a project and your home folder, set up for Claude Code, and what it does
        with each. dawg reads Claude Code’s files but never changes them.
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
          <option value="">No project: only your files</option>
        </select>
        <Button size="sm" disabled={busy} onClick={() => void load(projectDir)}>
          Refresh
        </Button>
      </div>

      {!loaded ? (
        problem === null && (
          <p className={settingsStyles.note} aria-live="polite">
            Reading the setup…
          </p>
        )
      ) : (
        <Report
          report={report}
          homeDir={homeDir}
          onReview={projectDir === null ? null : () => props.onReview(projectDir)}
        />
      )}
    </div>
  );
}

function Report(props: { report: CompatReport; homeDir: string; onReview: (() => void) | null }) {
  const { report, homeDir } = props;
  const sections = SECTIONS.map((section) => ({
    ...section,
    items: report.items.filter((item) => item.status === section.status),
  }));
  return (
    <>
      <div className={styles.summary}>
        {report.items.length > 0 && (
          <p className={styles.counts}>
            {sections
              .filter((section) => section.items.length > 0)
              .map((section) => (
                <Tag key={section.status} tone={section.tone}>
                  {section.items.length} {section.title.toLowerCase()}
                </Tag>
              ))}
          </p>
        )}
        <Approval approval={report.approval} onReview={props.onReview} />
      </div>

      {report.items.length === 0 ? (
        <div className={settingsStyles.empty}>
          <p className={settingsStyles.emptyTitle}>No Claude Code setup found</p>
          <p className={settingsStyles.emptyText}>
            dawg looked for CLAUDE.md files, settings files, skills, commands, subagents, hooks and
            MCP servers in{" "}
            {report.projectDir === null
              ? "your home folder"
              : `${shortenPath(report.projectDir, homeDir)} and your home folder`}
            .
          </p>
        </div>
      ) : (
        sections
          .filter((section) => section.items.length > 0)
          .map((section) => (
            <Section
              key={section.status}
              title={section.title}
              lead={section.lead}
              items={section.items}
              homeDir={homeDir}
            />
          ))
      )}
    </>
  );
}

/** The consent the setup's code has, read-only; the dialog behind "Review…" changes it. */
function Approval(props: { approval: CodeApproval | null; onReview: (() => void) | null }) {
  const { approval } = props;
  if (approval === null) {
    return (
      <p className={styles.approval}>
        <Icon name="shield" size={14} />
        <span>Nothing in this setup runs code that needs your consent.</span>
      </p>
    );
  }
  const count = approvalCount(approval);
  const many = approval.items.length !== 1;
  return (
    <p className={styles.approval}>
      <Icon name="shield" size={14} />
      {approval.approved ? <Tag tone="green">Approved</Tag> : <Tag tone="amber">Not approved</Tag>}
      <span className={styles.approvalText}>
        {approval.approved
          ? `You approved the code this setup supplies: ${count.toLowerCase()}.`
          : `${count} from this setup ${many ? "wait" : "waits"} for your consent before ${many ? "they run" : "it runs"}.`}
      </span>
      {props.onReview && (
        <Button size="sm" onClick={props.onReview}>
          Review…
        </Button>
      )}
    </p>
  );
}

function Section(props: {
  title: string;
  lead: string;
  items: readonly CompatItem[];
  homeDir: string;
}) {
  const headingId = useId();
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.h2}>
        {props.title} <span className={styles.count}>{props.items.length}</span>
      </h2>
      <p className={styles.sectionLead}>{props.lead}</p>
      <ul className={styles.items} aria-labelledby={headingId}>
        {props.items.map((item) => (
          <Item
            key={`${item.kind}\0${item.source.path}\0${item.name}\0${item.source.scope}`}
            item={item}
            homeDir={props.homeDir}
          />
        ))}
      </ul>
    </section>
  );
}

function Item(props: { item: CompatItem; homeDir: string }) {
  const { item } = props;
  const origin = item.source.origin === "claude" ? "Claude Code" : "dawg";
  return (
    <li className={styles.item}>
      <div className={styles.itemLine}>
        <Tag>{isSandboxHost(item) ? "Network" : KIND_LABEL[item.kind]}</Tag>
        <span className={styles.name}>{item.name}</span>
        <span className={styles.where}>
          {SCOPE_LABEL[item.source.scope]} · {origin}
        </span>
      </div>
      <code className={styles.path}>{shortenPath(item.source.path, props.homeDir)}</code>
      {item.notes.length > 0 && (
        <ul className={styles.notes} aria-label={`Notes on ${item.name}`}>
          {item.notes.map((note) => (
            <li key={note} className={styles.note}>
              {note}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
