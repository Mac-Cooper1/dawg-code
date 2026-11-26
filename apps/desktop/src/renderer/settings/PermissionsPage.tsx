/**
 * Settings → Permissions: the mode new sessions start in, and the allow, ask and deny rules of
 * every settings file that applies to a project. dawg's own files are edited here, each change
 * saved at once; Claude Code's are shown read-only. Open sessions apply a change from their
 * next turn. Talks to main through `permissions` on the bridge (src/main/permissions.ts).
 */
import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type {
  DawgBridge,
  DefaultMode,
  PermissionScope,
  PermissionSettingsFile,
  PermissionSettingsState,
  PermissionsWriteInput,
} from "../../shared/bridge.ts";
import { basename, shortenPath } from "../lib/format.ts";
import { MODE_INFO, MODE_ORDER, type ModeTone } from "../lib/modes.ts";
import { sidebarOrder } from "../state/sidebar-order.ts";
import type { AppState } from "../state/types.ts";
import { Button, Icon, IconButton, Tag, type TagTone } from "../ui/index.ts";
import styles from "./PermissionsPage.module.css";
import settingsStyles from "./Settings.module.css";

type RuleList = "allow" | "ask" | "deny";
const LISTS: readonly RuleList[] = ["allow", "ask", "deny"];

const LIST_INFO: Record<
  RuleList,
  { title: string; hint: string; placeholder: string; addLabel: string }
> = {
  allow: {
    title: "Allow",
    hint: "Runs without asking.",
    placeholder: "Bash(npm run test *)",
    addLabel: "Add an allow rule",
  },
  ask: {
    title: "Ask",
    hint: "Asks first, even when the mode or an allow rule would let it run.",
    placeholder: "Bash(git push *)",
    addLabel: "Add an ask rule",
  },
  deny: {
    title: "Deny",
    hint: "Never runs.",
    placeholder: "Read(./.env)",
    addLabel: "Add a deny rule",
  },
};

/** Scopes as the page names them, most specific first. */
const SCOPE_INFO: Record<PermissionScope, { title: string; description: string }> = {
  local: {
    title: "Personal for this project",
    description:
      "Only you, in this project and its worktrees. Kept out of git; “Always allow” saves here.",
  },
  project: {
    title: "Shared with the project",
    description: "Everyone who works on this project, through git.",
  },
  user: { title: "Yours everywhere", description: "You, in every project." },
};
const SCOPES: readonly PermissionScope[] = ["local", "project", "user"];

const MODE_TAG: Record<ModeTone, TagTone> = {
  neutral: "neutral",
  accent: "accent",
  blue: "neutral",
  amber: "amber",
  red: "red",
};

/** A project the picker offers. */
export interface PermissionsProject {
  dir: string;
  name: string;
}

export interface PermissionsPageProps {
  api: DawgBridge["permissions"];
  /** The projects in the sidebar, in its order. */
  projects: readonly PermissionsProject[];
  /** The project shown first (the selected session's), or null for only the person's files. */
  initialProject: string | null;
  homeDir: string;
  /** How long "Saved" shows after a change, in milliseconds. */
  savedForMs?: number;
}

/** The sidebar's projects, newest activity first, for the picker. */
export function permissionProjects(
  sessions: AppState["sessions"],
  projects: AppState["projects"],
): PermissionsProject[] {
  return sidebarOrder(sessions, "").map(({ projectDir }) => ({
    dir: projectDir,
    name: projects[projectDir]?.name ?? basename(projectDir),
  }));
}

/** A failure as one sentence, without Electron's "Error invoking remote method…". */
function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const cleaned = text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "").trim();
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

/**
 * The file new sessions take their mode from: the first, in precedence order, whose mode is not
 * ignored (bypass only counts from the person's own files, and not when a file turns it off).
 */
function modeSource(state: PermissionSettingsState): PermissionSettingsFile | null {
  return (
    state.files.find(
      (file) =>
        file.defaultMode !== null &&
        !(
          file.defaultMode === "bypassPermissions" &&
          (file.scope !== "user" || state.bypassDisabled)
        ),
    ) ?? null
  );
}

type Change = Omit<PermissionsWriteInput, "scope" | "projectDir">;

export function PermissionsPage(props: PermissionsPageProps) {
  const { api, homeDir } = props;
  const savedForMs = props.savedForMs ?? 2500;
  const projectId = useId();
  const [picked, setPicked] = useState(false);
  const [projectDir, setProjectDir] = useState<string | null>(props.initialProject);
  const [state, setState] = useState<PermissionSettingsState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ scope: PermissionScope; count: number } | null>(null);

  // Writes run one after another, each on the state the previous one left, so quick edits
  // compose instead of overwriting each other.
  const latest = useRef<PermissionSettingsState | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const shown = useRef<string | null>(projectDir);
  shown.current = projectDir;

  // Until the person picks a project, follow the selected session's (the store may still load).
  useEffect(() => {
    if (!picked) setProjectDir(props.initialProject);
  }, [picked, props.initialProject]);

  const load = useCallback(
    async (dir: string | null) => {
      try {
        const next = await api.read(dir);
        if (shown.current !== dir) return;
        latest.current = next;
        setState(next);
      } catch (error) {
        if (shown.current === dir) {
          setNotice(`Could not read the settings files: ${errorText(error)}`);
        }
      }
    },
    [api],
  );

  useEffect(() => {
    void load(projectDir);
  }, [load, projectDir]);

  // Files edited by hand elsewhere show when the window comes back.
  useEffect(() => {
    const refresh = () => {
      if (pending.current === 0) void load(shown.current);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);

  useEffect(() => {
    if (saved === null) return;
    const timer = setTimeout(() => setSaved(null), savedForMs);
    return () => clearTimeout(timer);
  }, [saved, savedForMs]);

  /** Saves a change to dawg's file in `scope`; resolves to whether it was saved. */
  const save = useCallback(
    (scope: PermissionScope, change: (file: PermissionSettingsFile) => Change | null) => {
      const dir = shown.current;
      pending.current += 1;
      const run = async (): Promise<boolean> => {
        const current = latest.current;
        if (current === null || current.projectDir !== dir) return false;
        const file = current.files.find((f) => f.scope === scope && f.origin === "dawg");
        if (file === undefined) return false;
        const patch = change(file);
        if (patch === null) return true;
        try {
          const next = await api.write({ scope, projectDir: dir, ...patch });
          if (shown.current === dir) {
            latest.current = next;
            setState(next);
          }
          setNotice(null);
          setSaved((previous) => ({ scope, count: (previous?.count ?? 0) + 1 }));
          return true;
        } catch (error) {
          setNotice(errorText(error));
          return false;
        }
      };
      const result = queue.current.then(run, run).finally(() => {
        pending.current -= 1;
      });
      queue.current = result.catch(() => undefined);
      return result;
    },
    [api],
  );

  const loaded = state !== null && state.projectDir === projectDir;
  const source = loaded ? modeSource(state) : null;
  const mode: DefaultMode = loaded ? state.defaultMode : "default";
  const projectChoices =
    projectDir !== null && !props.projects.some((p) => p.dir === projectDir)
      ? [{ dir: projectDir, name: basename(projectDir) }, ...props.projects]
      : props.projects;

  return (
    <div className={styles.page}>
      <h1 className={settingsStyles.h1}>Permissions</h1>
      <p className={settingsStyles.lead}>
        What dawg may do without asking. Changes save at once; open sessions apply them from their
        next turn.
      </p>

      {notice !== null && (
        <p className={styles.notice} role="alert">
          <Icon name="alert" size={14} />
          <span className={styles.noticeText}>{notice}</span>
          <IconButton icon="close" size="sm" label="Dismiss" onClick={() => setNotice(null)} />
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
          <option value="">No project: only your settings</option>
        </select>
      </div>

      {!loaded ? (
        <p className={settingsStyles.note} aria-live="polite">
          Reading the settings files…
        </p>
      ) : (
        <>
          <div className={styles.summary}>
            <p className={styles.summaryLine}>
              New sessions start in{" "}
              <Tag tone={MODE_TAG[MODE_INFO[mode].tone]}>{MODE_INFO[mode].label}</Tag>
              <span className={styles.muted}>{MODE_INFO[mode].description}.</span>
            </p>
            <p className={styles.muted}>
              {source === null
                ? "No settings file sets a mode, so this is the default."
                : `Set by ${shortenPath(source.path, homeDir)} (${SCOPE_INFO[source.scope].title}${
                    source.origin === "claude" ? ", Claude Code’s file" : ""
                  }).`}
              {state.bypassDisabled && " Bypass is turned off by a settings file."}
            </p>
            <p className={styles.muted}>
              Deny beats ask and ask beats allow, from any file; for the default mode, the more
              specific file wins.
            </p>
          </div>

          {SCOPES.map((scope) => {
            const files = state.files.filter((file) => file.scope === scope);
            if (files.length === 0) return null;
            return (
              <ScopeSection
                key={scope}
                scope={scope}
                files={files}
                homeDir={homeDir}
                saved={saved?.scope === scope ? saved.count : 0}
                api={api}
                save={save}
              />
            );
          })}
        </>
      )}
    </div>
  );
}

interface ScopeSectionProps {
  scope: PermissionScope;
  files: readonly PermissionSettingsFile[];
  homeDir: string;
  /** Counts saves in this scope while "Saved" shows; 0 hides it. */
  saved: number;
  api: DawgBridge["permissions"];
  save(
    scope: PermissionScope,
    change: (file: PermissionSettingsFile) => Change | null,
  ): Promise<boolean>;
}

function ScopeSection(props: ScopeSectionProps) {
  const headingId = useId();
  const info = SCOPE_INFO[props.scope];
  const own = props.files.find((file) => file.origin === "dawg");
  const claude = props.files.find((file) => file.origin === "claude");
  return (
    <section className={styles.scope} aria-labelledby={headingId}>
      <div className={styles.scopeHeader}>
        <h2 id={headingId} className={styles.h2}>
          {info.title}
        </h2>
        <span className={styles.saved} role="status">
          {props.saved > 0 && (
            <>
              <Icon name="check" size={12} />
              Saved
            </>
          )}
        </span>
      </div>
      <p className={styles.scopeLead}>{info.description}</p>
      {own && <OwnFile file={own} homeDir={props.homeDir} api={props.api} save={props.save} />}
      {claude && <ClaudeFile file={claude} homeDir={props.homeDir} />}
    </section>
  );
}

function Problems(props: { problems: readonly string[] }) {
  if (props.problems.length === 0) return null;
  return (
    <ul className={styles.problems} aria-label="Problems">
      {props.problems.map((problem) => (
        <li key={problem} className={styles.problem}>
          <Icon name="alert" size={12} />
          <span>{problem}</span>
        </li>
      ))}
    </ul>
  );
}

/** dawg's own file in a scope: editable unless it cannot be parsed. */
function OwnFile(props: {
  file: PermissionSettingsFile;
  homeDir: string;
  api: DawgBridge["permissions"];
  save: ScopeSectionProps["save"];
}) {
  const { file } = props;
  const modeId = useId();
  const scope = file.scope;
  const editable = file.writable;
  const modes = MODE_ORDER.filter(
    (m) => m !== "bypassPermissions" || scope === "user" || file.defaultMode === m,
  );

  return (
    <div className={styles.card}>
      <div className={styles.fileLine}>
        <code className={styles.path}>{shortenPath(file.path, props.homeDir)}</code>
        {!file.exists && <Tag>Not created yet</Tag>}
        {file.exists && !editable && <Tag tone="amber">Read-only</Tag>}
      </div>
      {!editable && (
        <p className={styles.fileNote}>dawg cannot change this file until it is fixed by hand.</p>
      )}
      <Problems problems={file.problems} />
      <div className={styles.modeRow}>
        <label className={styles.fieldLabel} htmlFor={modeId}>
          Default mode
        </label>
        <select
          id={modeId}
          className={styles.select}
          value={file.defaultMode ?? ""}
          disabled={!editable}
          onChange={(event) => {
            const value = event.target.value;
            void props.save(scope, () => ({
              defaultMode: value === "" ? null : (value as DefaultMode),
            }));
          }}
        >
          <option value="">Not set</option>
          {modes.map((m) => (
            <option key={m} value={m}>
              {MODE_INFO[m].label}
            </option>
          ))}
        </select>
        <span className={styles.muted}>
          {file.defaultMode === null
            ? "Left to the other files."
            : `${MODE_INFO[file.defaultMode].description}.`}
        </span>
      </div>
      <div className={styles.lists}>
        {LISTS.map((list) => (
          <RuleListView
            key={list}
            list={list}
            rules={file[list]}
            editable={editable}
            api={props.api}
            onAdd={(rule) =>
              props.save(scope, (current) =>
                current[list].includes(rule) ? null : { [list]: [...current[list], rule] },
              )
            }
            onRemove={(rule) =>
              props.save(scope, (current) => ({ [list]: current[list].filter((r) => r !== rule) }))
            }
            onMove={(rule, to) =>
              props.save(scope, (current) => ({
                [list]: current[list].filter((r) => r !== rule),
                [to]: current[to].includes(rule) ? current[to] : [...current[to], rule],
              }))
            }
          />
        ))}
      </div>
    </div>
  );
}

/** Claude Code's file in a scope: shown as it is, never changed. */
function ClaudeFile(props: { file: PermissionSettingsFile; homeDir: string }) {
  const { file } = props;
  const path = shortenPath(file.path, props.homeDir);
  if (!file.exists) {
    return <p className={styles.claudeMissing}>No Claude Code file at {path}.</p>;
  }
  const empty = file.defaultMode === null && LISTS.every((list) => file[list].length === 0);
  return (
    <div className={`${styles.card} ${styles.claudeCard}`}>
      <div className={styles.fileLine}>
        <span className={styles.claudeTitle}>Claude Code’s file</span>
        <code className={styles.path}>{path}</code>
        <Tag>Read-only</Tag>
      </div>
      <p className={styles.fileNote}>dawg reads this file but never changes it.</p>
      <Problems problems={file.problems} />
      {empty ? (
        <p className={styles.muted}>No permission settings in it.</p>
      ) : (
        <>
          {file.defaultMode !== null && (
            <p className={styles.claudeMode}>
              Default mode: <strong>{MODE_INFO[file.defaultMode].label}</strong>
            </p>
          )}
          <div className={styles.lists}>
            {LISTS.filter((list) => file[list].length > 0).map((list) => (
              <RuleListView key={list} list={list} rules={file[list]} editable={false} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface RuleListViewProps {
  list: RuleList;
  rules: readonly string[];
  editable: boolean;
  api?: DawgBridge["permissions"];
  onAdd?(rule: string): Promise<boolean>;
  onRemove?(rule: string): Promise<boolean>;
  onMove?(rule: string, to: RuleList): Promise<boolean>;
}

/** One list's rules, with remove and move on each, and a field that adds one. */
function RuleListView(props: RuleListViewProps) {
  const headingId = useId();
  const info = LIST_INFO[props.list];
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // After a remove or a move, focus goes to the rule that took its place, else the field.
  const refocusAt = useRef<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the rules change
  useEffect(() => {
    const index = refocusAt.current;
    if (index === null) return;
    refocusAt.current = null;
    const rows = listRef.current?.querySelectorAll<HTMLElement>("li[data-rule]") ?? [];
    const row = rows[Math.min(index, rows.length - 1)];
    const target = row?.querySelector<HTMLElement>("button") ?? inputRef.current;
    target?.focus();
  }, [props.rules]);

  const act = (index: number, action: Promise<boolean>) => {
    void action.then((done) => {
      if (done) refocusAt.current = index;
    });
  };

  return (
    <div className={styles.list} data-list={props.list}>
      <div className={styles.listHeader}>
        <h3 id={headingId} className={styles.h3}>
          {info.title}
          <span className={styles.count}>{props.rules.length}</span>
        </h3>
        <span className={styles.muted}>{info.hint}</span>
      </div>
      {props.rules.length === 0 ? (
        <p className={styles.none}>No rules.</p>
      ) : (
        <ul ref={listRef} className={styles.rules} aria-labelledby={headingId}>
          {props.rules.map((rule, index) => (
            <RuleRow
              key={rule}
              rule={rule}
              list={props.list}
              editable={props.editable}
              onRemove={() => props.onRemove && act(index, props.onRemove(rule))}
              onMove={(to) => props.onMove && act(index, props.onMove(rule, to))}
            />
          ))}
        </ul>
      )}
      {props.editable && props.api && props.onAdd && (
        <RuleInput
          list={props.list}
          rules={props.rules}
          inputRef={inputRef}
          check={props.api.checkRule}
          onAdd={props.onAdd}
        />
      )}
    </div>
  );
}

function RuleRow(props: {
  rule: string;
  list: RuleList;
  editable: boolean;
  onRemove(): void;
  onMove(to: RuleList): void;
}) {
  const ruleId = useId();
  return (
    <li className={styles.rule} data-rule={props.rule}>
      <code id={ruleId} className={styles.ruleText}>
        {props.rule}
      </code>
      {props.editable && (
        <span className={styles.ruleActions}>
          {LISTS.filter((other) => other !== props.list).map((other) => (
            <Button
              key={other}
              size="sm"
              variant="ghost"
              aria-describedby={ruleId}
              onClick={() => props.onMove(other)}
            >
              Move to {LIST_INFO[other].title.toLowerCase()}
            </Button>
          ))}
          <IconButton
            icon="trash"
            size="sm"
            label="Remove rule"
            aria-describedby={ruleId}
            onClick={props.onRemove}
          />
        </span>
      )}
    </li>
  );
}

/** How long typing pauses before a rule is checked. */
const CHECK_DELAY_MS = 150;

/** The field that adds a rule: checked as it is typed, added with Enter or Add. */
function RuleInput(props: {
  list: RuleList;
  rules: readonly string[];
  inputRef: RefObject<HTMLInputElement | null>;
  check(rule: string): Promise<string | null>;
  onAdd(rule: string): Promise<boolean>;
}) {
  const { check } = props;
  const info = LIST_INFO[props.list];
  const messageId = useId();
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const checks = useRef(0);
  const rule = value.trim();
  const duplicate = rule !== "" && props.rules.includes(rule);

  useEffect(() => {
    const seq = ++checks.current;
    if (rule === "" || duplicate) {
      setProblem(null);
      return;
    }
    const timer = setTimeout(() => {
      void check(rule).then(
        (result) => {
          if (checks.current === seq) setProblem(result);
        },
        () => {
          if (checks.current === seq) setProblem(null);
        },
      );
    }, CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [rule, duplicate, check]);

  const message = duplicate ? "Already in this list." : problem;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (rule === "" || duplicate || adding) return;
    setAdding(true);
    try {
      // The field may be ahead of the last check: check what is being added.
      const error = await check(rule).catch(() => null);
      if (error !== null) {
        setProblem(error);
        return;
      }
      if (await props.onAdd(rule)) {
        setValue("");
        setProblem(null);
        props.inputRef.current?.focus();
      }
    } finally {
      setAdding(false);
    }
  };

  return (
    <form className={styles.add} onSubmit={(event) => void submit(event)}>
      <div className={styles.addRow}>
        <input
          ref={props.inputRef}
          className={styles.input}
          aria-label={info.addLabel}
          aria-invalid={message !== null}
          aria-describedby={messageId}
          placeholder={info.placeholder}
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
        />
        {/* A message may be from a check of what was typed a moment ago, so it does not
            disable Add: Enter always tries, and adding checks the rule again. */}
        <Button type="submit" size="sm" disabled={rule === "" || duplicate || adding}>
          Add
        </Button>
      </div>
      <p id={messageId} className={styles.inputMessage} aria-live="polite">
        {message}
      </p>
    </form>
  );
}
