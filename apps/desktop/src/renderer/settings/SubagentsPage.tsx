/**
 * Settings → Subagents: every agent a project's new sessions can hand a task to with the `Agent`
 * tool (`project.subagents`): dawg's built-ins, and agent files (`agents/*.md`) from the person's
 * folders and the project's, Claude Code's and dawg's, with what each is given and what dawg does
 * with fields it maps or ignores. "Open file" opens a file in the person's own editor.
 *
 * "New subagent" writes a file in the documented front matter format (`subagent.create`), only
 * ever under `.dawg`: the person's `~/.dawg/agents/` or the project's `.dawg/agents/`. Sessions
 * read agents when they start, so a new one is there from the next session. A project file that
 * grants tools waits for the project's code to be approved, as any project agent does.
 *
 * Named "Subagents", not "Agents": that name is kept for a later, different feature.
 */
import type { SubagentDefinition } from "@dawg/protocol";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { basename, shortenPath } from "../lib/format.ts";
import { sourceLabel } from "../lib/hooks.ts";
import { MODE_INFO } from "../lib/modes.ts";
import type { NewSubagentInput, SubagentsListing } from "../state/types.ts";
import { Button, Icon, IconButton, Spinner, Tag, type TagTone } from "../ui/index.ts";
import type { PermissionsProject } from "./PermissionsPage.tsx";
import settingsStyles from "./Settings.module.css";
import styles from "./SubagentsPage.module.css";

/** What a status means for an agent, in a few words; nothing for one that works as written. */
const STATUS: Partial<Record<SubagentDefinition["status"], { label: string; tone: TagTone }>> = {
  "needs-approval": { label: "Needs approval", tone: "amber" },
  "partly-supported": { label: "Partly supported", tone: "amber" },
  invalid: { label: "Could not be loaded", tone: "red" },
  overridden: { label: "Overridden", tone: "neutral" },
};

const MEMORY_WORDS: Record<NonNullable<SubagentDefinition["memory"]>, string> = {
  user: "Yours, for every project",
  project: "The project’s, shared",
  local: "Yours, for this project",
};

/** The documented examples of names; the form checks the same rule the engine does. */
const BUILT_IN_NAMES = ["Explore", "Plan", "general-purpose"];

export interface SubagentsPageProps {
  /** The projects in the sidebar, in its order. */
  projects: readonly PermissionsProject[];
  /** The project shown first (the selected session's), or null for only the person's own. */
  initialProject: string | null;
  homeDir: string;
  listSubagents(projectDir: string | null): Promise<SubagentsListing | { error: string }>;
  createSubagent(
    input: NewSubagentInput,
  ): Promise<{ path: string; agent: SubagentDefinition } | { error: string }>;
  /** Opens an agent file in the person's editor. */
  onOpenFile(path: string): void;
}

/** Why a name cannot be given to a new agent file, or null (as compat's `newAgentNameProblem`). */
export function newSubagentNameProblem(name: string): string | null {
  if (name === "") return "Give the subagent a name.";
  if (name.length > 64) return "A name has at most 64 characters.";
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
    return "Use lowercase letters, digits and single hyphens, starting with a letter, as in code-reviewer.";
  }
  if (name === "fork") return "“fork” names a copy of the conversation; choose another name.";
  if (BUILT_IN_NAMES.includes(name)) {
    return `“${name}” is one of dawg’s built-in agents. To replace it, write the file by hand.`;
  }
  return null;
}

/**
 * The entries of a tools field as the reader splits them: by commas and spaces, except inside
 * brackets, so `Bash(npm test *)` stays one entry.
 */
export function splitTools(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if ((ch === ")" || ch === "]" || ch === "}") && depth > 0) depth -= 1;
    if (depth === 0 && (ch === "," || /\s/.test(ch))) {
      if (current.trim() !== "") out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

/** Entries written as a permission rule, `Tool(specifier)`: from a project file, they wait for approval. */
function grantsIn(tools: readonly string[]): string[] {
  return tools.filter((entry) => {
    const match = /^([A-Za-z_][\w-]*)\((.*)\)$/s.exec(entry);
    return match !== null && match[1] !== "Agent";
  });
}

type Group = { id: "builtin" | "user" | "project"; title: string; agents: SubagentDefinition[] };

function groupsOf(agents: readonly SubagentDefinition[]): Group[] {
  const groups: Group[] = [
    { id: "builtin", title: "Built in", agents: [] },
    { id: "user", title: "Yours", agents: [] },
    { id: "project", title: "This project", agents: [] },
  ];
  for (const agent of agents) {
    const id = agent.builtIn ? "builtin" : agent.source?.scope === "user" ? "user" : "project";
    groups.find((g) => g.id === id)?.agents.push(agent);
  }
  return groups.filter((g) => g.agents.length > 0);
}

export function SubagentsPage(props: SubagentsPageProps) {
  const { homeDir, listSubagents } = props;
  const projectId = useId();
  const [picked, setPicked] = useState(false);
  const [projectDir, setProjectDir] = useState<string | null>(props.initialProject);
  const [listing, setListing] = useState<SubagentsListing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [made, setMade] = useState<{ path: string; name: string } | null>(null);
  const shown = useRef<string | null>(projectDir);
  shown.current = projectDir;
  const newButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /** The file of an agent just made, whose row takes focus once a listing shows it. */
  const focusPath = useRef<string | null>(null);

  // Until the person picks a project, follow the selected session's (the store may still load).
  useEffect(() => {
    if (!picked) setProjectDir(props.initialProject);
  }, [picked, props.initialProject]);

  const load = useCallback(
    async (dir: string | null) => {
      const result = await listSubagents(dir);
      if (shown.current !== dir) return;
      if ("error" in result) {
        setProblem(`Could not list the subagents: ${result.error}`);
        return;
      }
      setProblem(null);
      setListing(result);
    },
    [listSubagents],
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

  // A new agent's row takes focus once the listing that holds it is drawn, once.
  useEffect(() => {
    const wanted = focusPath.current;
    if (wanted === null || listing === null) return;
    const row = [...(list.current?.querySelectorAll<HTMLElement>("[data-path]") ?? [])].find(
      (element) => element.dataset.path === wanted,
    );
    if (row === undefined) return;
    focusPath.current = null;
    row.focus();
  }, [listing]);

  const loaded = listing !== null && listing.projectDir === projectDir;
  const projectChoices =
    projectDir !== null && !props.projects.some((p) => p.dir === projectDir)
      ? [{ dir: projectDir, name: basename(projectDir) }, ...props.projects]
      : props.projects;
  const groups = loaded ? groupsOf(listing.agents) : [];
  const files = loaded ? listing.agents.filter((agent) => !agent.builtIn) : [];

  return (
    <div className={styles.page}>
      <h1 className={settingsStyles.h1}>Subagents</h1>
      <p className={settingsStyles.lead}>
        Agents the model can hand a task to: dawg’s built-ins, and agent files from your home folder
        and the project, read as Claude Code reads them. Sessions read them when they start, so a
        new one is there from the next session.
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
            setMade(null);
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
        <span className={styles.grow} />
        {!formOpen && (
          <Button
            ref={newButton}
            icon="plus"
            size="sm"
            disabled={!loaded}
            onClick={() => {
              setMade(null);
              setFormOpen(true);
            }}
          >
            New subagent
          </Button>
        )}
      </div>

      <p className={styles.status} role="status">
        {made === null
          ? ""
          : `Made ${made.name}: ${shortenPath(made.path, homeDir)}. New sessions can start it.`}
      </p>

      {formOpen && loaded && (
        <NewSubagentForm
          listing={listing}
          homeDir={homeDir}
          createSubagent={props.createSubagent}
          onCancel={() => {
            setFormOpen(false);
            // Focus goes back to the button that opened the form, once it is drawn again.
            setTimeout(() => newButton.current?.focus(), 0);
          }}
          onMade={(result) => {
            setFormOpen(false);
            setMade({ path: result.path, name: result.agent.name });
            focusPath.current = result.path;
            void load(shown.current);
          }}
        />
      )}

      {!loaded ? (
        problem === null && (
          <p className={settingsStyles.note} aria-live="polite">
            Reading the subagents…
          </p>
        )
      ) : (
        <div ref={list}>
          {groups.map((group) => (
            <AgentGroup key={group.id} group={group} homeDir={homeDir} onOpen={props.onOpenFile} />
          ))}
          {files.length === 0 && (
            <p className={settingsStyles.note}>
              No agent files yet. Put one in <code>~/.claude/agents/</code> for every project, or in{" "}
              <code>.claude/agents/</code> inside a project; the same folders under{" "}
              <code>.dawg</code> work too, and win over <code>.claude</code>. Or make one with New
              subagent.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function AgentGroup(props: { group: Group; homeDir: string; onOpen(path: string): void }) {
  const headingId = useId();
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.h2}>
        {props.group.title}
        <span className={styles.count}>{props.group.agents.length}</span>
      </h2>
      <ul className={styles.list} aria-labelledby={headingId}>
        {props.group.agents.map((agent) => (
          <AgentRow
            key={`${agent.source?.path ?? "builtin"}\u0000${agent.name}`}
            agent={agent}
            homeDir={props.homeDir}
            onOpen={props.onOpen}
          />
        ))}
      </ul>
    </section>
  );
}

/** The details worth showing for an agent, as label and value; rows that say nothing are left out. */
export function agentDetails(
  agent: SubagentDefinition,
  homeDir: string,
): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  out.push({
    label: "Tools",
    value:
      agent.tools === null
        ? "All tools a subagent can have"
        : agent.tools.length === 0
          ? "None listed"
          : agent.tools.join(", "),
  });
  if (agent.disallowedTools.length > 0) {
    out.push({ label: "Not given", value: agent.disallowedTools.join(", ") });
  }
  out.push({
    label: "Model",
    value:
      agent.model === null
        ? "Inherits the session’s model"
        : `${agent.model}, runs on ${agent.mappedModel ?? "the session’s model"}`,
  });
  out.push({
    label: "Permission mode",
    value: agent.readOnly
      ? "Plan (read-only)"
      : agent.permissionMode === null
        ? "The parent’s"
        : MODE_INFO[agent.permissionMode].label,
  });
  if (agent.memory !== null) {
    out.push({
      label: "Memory",
      value:
        agent.memoryDirectory === null
          ? `${MEMORY_WORDS[agent.memory]} (in a project’s sessions)`
          : `${MEMORY_WORDS[agent.memory]}: ${shortenPath(agent.memoryDirectory, homeDir)}`,
    });
  }
  if (agent.mcpServers.length > 0) {
    out.push({
      label: "MCP servers",
      value: agent.mcpServers
        .map((server) => (server.inline ? `${server.name} (its own)` : server.name))
        .join(", "),
    });
  }
  const runs = [
    agent.background ? "In the background" : "",
    agent.isolation === "worktree" ? "In a git worktree of its own" : "",
  ].filter((part) => part !== "");
  if (runs.length > 0) out.push({ label: "Runs", value: runs.join("; ") });
  if (agent.maxTurns !== null) {
    out.push({
      label: "Turn limit",
      value: `${agent.maxTurns} model request${agent.maxTurns === 1 ? "" : "s"} per task`,
    });
  }
  if (agent.skills.length > 0) out.push({ label: "Skills", value: agent.skills.join(", ") });
  return out;
}

function AgentRow(props: {
  agent: SubagentDefinition;
  homeDir: string;
  onOpen(path: string): void;
}) {
  const { agent, homeDir } = props;
  const nameId = useId();
  const status = STATUS[agent.status];
  const unused = agent.status === "overridden" || agent.status === "invalid";
  const source = agent.source;
  const replacedNote =
    agent.overriddenBy !== null && !agent.notes.some((note) => note.startsWith("Not used"))
      ? `Not used: ${shortenPath(agent.overriddenBy, homeDir)} takes its place.`
      : null;
  return (
    <li
      className={unused ? `${styles.row} ${styles.unused}` : styles.row}
      tabIndex={-1}
      aria-labelledby={nameId}
      {...(source === null ? {} : { "data-path": source.path })}
    >
      <div className={styles.rowHead}>
        <span id={nameId} className={styles.name}>
          {agent.name}
        </span>
        <Tag>{agent.builtIn ? "Built in" : source?.scope === "user" ? "Personal" : "Project"}</Tag>
        {status !== undefined && <Tag tone={status.tone}>{status.label}</Tag>}
        {source !== null && (
          <>
            <span className={styles.grow} />
            <Button
              size="sm"
              variant="ghost"
              icon="file"
              aria-describedby={nameId}
              onClick={() => props.onOpen(source.path)}
            >
              Open file
            </Button>
          </>
        )}
      </div>
      {agent.description !== "" && <p className={styles.description}>{agent.description}</p>}
      <p className={styles.meta}>
        {source === null ? (
          "dawg’s own, written for this project."
        ) : (
          <>
            <code className={styles.path}>{shortenPath(source.path, homeDir)}</code>
            <span> · {sourceLabel(source)}</span>
          </>
        )}
      </p>
      {agent.status !== "invalid" && (
        <dl className={styles.details}>
          {agentDetails(agent, homeDir).map((detail) => (
            <div key={detail.label} className={styles.detail}>
              <dt>{detail.label}</dt>
              <dd>{detail.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {(agent.notes.length > 0 || replacedNote !== null) && (
        <ul className={styles.notes} aria-label="Notes">
          {replacedNote !== null && <li>{replacedNote}</li>}
          {agent.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// New subagent
// ---------------------------------------------------------------------------------------------

function NewSubagentForm(props: {
  listing: SubagentsListing;
  homeDir: string;
  createSubagent: SubagentsPageProps["createSubagent"];
  onCancel(): void;
  onMade(result: { path: string; agent: SubagentDefinition }): void;
}) {
  const { listing, homeDir } = props;
  const headingId = useId();
  const nameId = useId();
  const nameHintId = useId();
  const descriptionId = useId();
  const descriptionHintId = useId();
  const promptId = useId();
  const toolsId = useId();
  const toolsHintId = useId();
  const memoryId = useId();
  const whereName = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [tools, setTools] = useState("");
  const [memory, setMemory] = useState<NewSubagentInput["memory"]>(null);
  const [touched, setTouched] = useState({ name: false, description: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    nameInput.current?.focus();
  }, []);

  const trimmed = name.trim();
  const folder = scope === "user" ? listing.folders.user : listing.folders.project;
  const target = folder === null ? null : `${folder}/${trimmed === "" ? "<name>" : trimmed}.md`;
  const nameProblem = newSubagentNameProblem(trimmed);
  const fileTaken =
    nameProblem === null &&
    target !== null &&
    listing.agents.some((agent) => agent.source?.path === target);
  const sameName =
    nameProblem === null && !fileTaken
      ? listing.agents.find((agent) => !agent.builtIn && agent.name === trimmed)
      : undefined;
  const descriptionProblem =
    description.trim() === ""
      ? "Say what the agent does and when to use it: the model reads this to choose it."
      : null;
  const entries = splitTools(tools);
  const grants = scope === "project" ? grantsIn(entries) : [];
  const canSubmit = !busy && nameProblem === null && !fileTaken && descriptionProblem === null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched({ name: true, description: true });
    if (!canSubmit) {
      (nameProblem !== null || fileTaken
        ? nameInput.current
        : document.getElementById(descriptionId)
      )?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const result = await props.createSubagent({
      projectDir: listing.projectDir,
      scope,
      name: trimmed,
      description: description.trim(),
      prompt,
      tools: entries.length === 0 ? null : entries,
      memory,
    });
    setBusy(false);
    if ("error" in result) {
      setError(`Could not make the subagent: ${result.error}`);
      return;
    }
    props.onMade(result);
  };

  return (
    <section className={styles.form} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.formTitle}>
        New subagent
      </h2>
      <form className={styles.fields} onSubmit={(event) => void submit(event)} noValidate>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={nameId}>
            Name
          </label>
          <input
            ref={nameInput}
            id={nameId}
            className={`${styles.input} ${styles.mono}`}
            value={name}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            placeholder="code-reviewer"
            aria-invalid={(touched.name && nameProblem !== null) || fileTaken}
            aria-describedby={nameHintId}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, name: true }))}
          />
          <p id={nameHintId} className={styles.hint}>
            {touched.name && nameProblem !== null ? (
              <span className={styles.problem}>{nameProblem}</span>
            ) : fileTaken && target !== null ? (
              <span className={styles.problem}>
                {shortenPath(target, homeDir)} already exists, and dawg never overwrites a file.
                Choose another name, or open that file.
              </span>
            ) : sameName !== undefined ? (
              `An agent named “${trimmed}” is already listed (${shortenPath(sameName.source?.path ?? "", homeDir)}). Which one sessions use follows the usual order: the project’s over yours, .dawg over .claude.`
            ) : (
              "What the model passes to start it: lowercase letters, digits and hyphens."
            )}
          </p>
        </div>

        <fieldset className={styles.fieldset}>
          <legend className={styles.label}>Where</legend>
          <label className={styles.choice}>
            <input
              type="radio"
              name={whereName}
              value="user"
              checked={scope === "user"}
              disabled={busy}
              onChange={() => setScope("user")}
            />
            <span>
              <span className={styles.choiceTitle}>Just for you</span>
              <code className={styles.choicePath}>
                {shortenPath(`${listing.folders.user}/${trimmed || "<name>"}.md`, homeDir)}
              </code>
            </span>
          </label>
          <label className={styles.choice}>
            <input
              type="radio"
              name={whereName}
              value="project"
              checked={scope === "project"}
              disabled={busy || listing.folders.project === null}
              onChange={() => setScope("project")}
            />
            <span>
              <span className={styles.choiceTitle}>This project</span>
              <code className={styles.choicePath}>
                {listing.folders.project === null
                  ? "Pick a project first"
                  : shortenPath(`${listing.folders.project}/${trimmed || "<name>"}.md`, homeDir)}
              </code>
            </span>
          </label>
        </fieldset>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={descriptionId}>
            Description
          </label>
          <input
            id={descriptionId}
            className={styles.input}
            value={description}
            disabled={busy}
            placeholder="Reviews code for quality, security and tests. Use after changes."
            aria-invalid={touched.description && descriptionProblem !== null}
            aria-describedby={descriptionHintId}
            onChange={(event) => setDescription(event.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, description: true }))}
          />
          <p id={descriptionHintId} className={styles.hint}>
            {touched.description && descriptionProblem !== null ? (
              <span className={styles.problem}>{descriptionProblem}</span>
            ) : (
              "When the model should hand it a task."
            )}
          </p>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={promptId}>
            System prompt
          </label>
          <textarea
            id={promptId}
            className={styles.textarea}
            value={prompt}
            disabled={busy}
            rows={5}
            placeholder="You are a code reviewer. When given changes, check…"
            onChange={(event) => setPrompt(event.target.value)}
          />
        </div>

        <div className={styles.row2}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={toolsId}>
              Tools
            </label>
            <input
              id={toolsId}
              className={`${styles.input} ${styles.mono}`}
              value={tools}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              placeholder="Read, Grep, Glob"
              aria-describedby={toolsHintId}
              onChange={(event) => setTools(event.target.value)}
            />
            <p id={toolsHintId} className={styles.hint}>
              Leave empty for every tool a subagent can have.
            </p>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={memoryId}>
              Memory
            </label>
            <select
              id={memoryId}
              className={styles.input}
              value={memory ?? ""}
              disabled={busy}
              onChange={(event) =>
                setMemory(
                  event.target.value === ""
                    ? null
                    : (event.target.value as NonNullable<NewSubagentInput["memory"]>),
                )
              }
            >
              <option value="">None</option>
              <option value="user">Yours, every project</option>
              <option value="project">The project’s, shared</option>
              <option value="local">Yours, this project</option>
            </select>
          </div>
        </div>

        <p className={styles.what} aria-live="polite">
          {target === null
            ? "Pick a project to make one for it."
            : `Writes ${shortenPath(target, homeDir)}. New sessions can start it; sessions already open keep the agents they started with.`}
          {grants.length > 0 &&
            ` Its tools field lets ${grants.join(", ")} run without asking, so in a project file that waits until you approve the project’s code.`}
        </p>

        {error !== null && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <div className={styles.actions}>
          <Button disabled={busy} onClick={props.onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || target === null}>
            {busy ? (
              <>
                <Spinner size={12} />
                Making it…
              </>
            ) : (
              "Make subagent"
            )}
          </Button>
        </div>
      </form>
    </section>
  );
}
