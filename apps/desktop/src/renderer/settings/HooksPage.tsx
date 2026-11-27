/**
 * Settings → Hooks: every hook in the settings files that apply to a project (Claude Code's and
 * dawg's, the person's and the project's), with its event, matcher, command and source, whether
 * dawg runs it (and whether it waits for the person's consent), and a switch to turn it off.
 *
 * The switches are kept in dawg's data folder by the engine (`hooks.setEnabled`), never in a
 * settings file: Claude Code's files stay exactly as they are, a shared `.dawg/settings.json`
 * does not carry one person's choice to everyone, and a hook that changes comes back on.
 */
import type { CompatItemStatus, HookInfo } from "@dawg/protocol";
import { Switch } from "radix-ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { basename, shortenPath } from "../lib/format.ts";
import { STATUS_LABEL, sourceLabel } from "../lib/hooks.ts";
import type { HooksListing } from "../state/types.ts";
import { Button, Icon, IconButton, Tag, type TagTone } from "../ui/index.ts";
import styles from "./HooksPage.module.css";
import type { PermissionsProject } from "./PermissionsPage.tsx";
import settingsStyles from "./Settings.module.css";

const STATUS_TONE: Record<CompatItemStatus, TagTone> = {
  loaded: "green",
  "needs-approval": "amber",
  "partly-supported": "amber",
  "not-supported": "neutral",
  invalid: "red",
};

export interface HooksPageProps {
  /** The projects in the sidebar, in its order. */
  projects: readonly PermissionsProject[];
  /** The project shown first (the selected session's), or null for only the person's files. */
  initialProject: string | null;
  homeDir: string;
  listHooks(projectDir: string | null): Promise<HooksListing | { error: string }>;
  /** False when it failed (the store shows a notice). */
  setHookEnabled(projectDir: string | null, id: string, enabled: boolean): Promise<boolean>;
  /** Opens the project trust dialog. */
  onReview(projectDir: string): void;
}

/** "PreToolUse on Bash", "Stop": the hook's event and what it matches. */
export function hookTitle(hook: Pick<HookInfo, "event" | "matcher">): string {
  const matcher = hook.matcher?.trim() ?? "";
  return matcher === "" || matcher === "*" ? hook.event : `${hook.event} on ${matcher}`;
}

export function HooksPage(props: HooksPageProps) {
  const { homeDir, listHooks, setHookEnabled } = props;
  const projectId = useId();
  const [picked, setPicked] = useState(false);
  const [projectDir, setProjectDir] = useState<string | null>(props.initialProject);
  const [listing, setListing] = useState<HooksListing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = useRef<string | null>(projectDir);
  shown.current = projectDir;
  /** Switches being saved: their answers must not be overwritten by an older listing. */
  const saving = useRef(0);

  // Until the person picks a project, follow the selected session's (the store may still load).
  useEffect(() => {
    if (!picked) setProjectDir(props.initialProject);
  }, [picked, props.initialProject]);

  const load = useCallback(
    async (dir: string | null) => {
      const result = await listHooks(dir);
      if (shown.current !== dir) return;
      if ("error" in result) {
        setProblem(`Could not list the hooks: ${result.error}`);
        return;
      }
      setProblem(null);
      setListing(result);
    },
    [listHooks],
  );

  useEffect(() => {
    void load(projectDir);
  }, [load, projectDir]);

  // Settings files edited elsewhere, and approvals given in the dialog, show when the window
  // comes back.
  useEffect(() => {
    const refresh = () => {
      if (saving.current === 0) void load(shown.current);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);

  const toggle = useCallback(
    async (hook: HookInfo, enabled: boolean) => {
      const dir = shown.current;
      const set = (value: boolean) =>
        setListing((current) =>
          current === null || current.projectDir !== dir
            ? current
            : {
                ...current,
                hooks: current.hooks.map((h) => (h.id === hook.id ? { ...h, enabled: value } : h)),
              },
        );
      // At once, so the switch follows the hand; put back if the engine refused.
      set(enabled);
      saving.current += 1;
      try {
        const saved = await setHookEnabled(dir, hook.id, enabled);
        if (!saved) set(!enabled);
      } finally {
        saving.current -= 1;
      }
    },
    [setHookEnabled],
  );

  const loaded = listing !== null && listing.projectDir === projectDir;
  const waiting = loaded && listing.hooks.some((hook) => hook.status === "needs-approval");
  const projectChoices =
    projectDir !== null && !props.projects.some((p) => p.dir === projectDir)
      ? [{ dir: projectDir, name: basename(projectDir) }, ...props.projects]
      : props.projects;

  return (
    <div className={styles.page}>
      <h1 className={settingsStyles.h1}>Hooks</h1>
      <p className={settingsStyles.lead}>
        Commands your settings files run at points in a session, as in Claude Code. Open sessions
        apply changes to the files from their next turn.
      </p>
      <p className={settingsStyles.note}>
        A switch turns one hook off for you alone. dawg keeps the switches in its own data folder,
        so Claude Code’s files and the project’s are never changed.
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
          <option value="">No project: only your settings</option>
        </select>
      </div>

      {!loaded ? (
        problem === null && (
          <p className={settingsStyles.note} aria-live="polite">
            Reading the settings files…
          </p>
        )
      ) : (
        <>
          {listing.disabledBy !== null && (
            <p className={styles.banner} role="status">
              <Icon name="alert" size={14} />
              <span>
                Every hook is off: <code>disableAllHooks</code> is set in{" "}
                <code>{shortenPath(listing.disabledBy, homeDir)}</code>.
              </span>
            </p>
          )}
          {waiting && projectDir !== null && (
            <div className={styles.waiting}>
              <Icon name="shield" size={14} />
              <span className={styles.waitingText}>
                Some of these come from the project and wait for your approval before they run.
              </span>
              <Button size="sm" onClick={() => props.onReview(projectDir)}>
                Review
              </Button>
            </div>
          )}
          {listing.hooks.length === 0 ? (
            <div className={settingsStyles.empty}>
              <p className={settingsStyles.emptyTitle}>No hooks</p>
              <p className={settingsStyles.emptyText}>
                None of the settings files that apply here has a <code>hooks</code> section.
              </p>
            </div>
          ) : (
            <ul className={styles.list} aria-label="Hooks">
              {listing.hooks.map((hook) => (
                <HookRow
                  key={hook.id}
                  hook={hook}
                  homeDir={homeDir}
                  allOff={listing.disabledBy !== null}
                  onToggle={(enabled) => void toggle(hook, enabled)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function HookRow(props: {
  hook: HookInfo;
  homeDir: string;
  allOff: boolean;
  onToggle(enabled: boolean): void;
}) {
  const { hook } = props;
  const titleId = useId();
  const detailId = useId();
  const title = hookTitle(hook);
  return (
    <li className={hook.enabled ? styles.row : `${styles.row} ${styles.off}`}>
      <div className={styles.rowMain}>
        <div className={styles.rowHead}>
          <span id={titleId} className={styles.event}>
            {title}
          </span>
          <Tag tone={STATUS_TONE[hook.status]}>{STATUS_LABEL[hook.status]}</Tag>
          {hook.type !== "command" && <Tag>{hook.type}</Tag>}
        </div>
        <div id={detailId} className={styles.rowDetail}>
          <code className={styles.command}>{hook.command}</code>
          <p className={styles.source}>
            <code className={styles.path}>{shortenPath(hook.source.path, props.homeDir)}</code>
            <span> · {sourceLabel(hook.source)}</span>
            {hook.timeout !== null && <span> · times out after {hook.timeout} s</span>}
          </p>
          {hook.notes.length > 0 && (
            <ul className={styles.notes}>
              {hook.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <Switch.Root
        className={styles.switch}
        checked={hook.enabled}
        onCheckedChange={props.onToggle}
        aria-label={`${title}: ${hook.command}`}
        aria-describedby={detailId}
        title={props.allOff ? "Every hook is off in the settings files" : undefined}
      >
        <Switch.Thumb className={styles.thumb} />
      </Switch.Root>
    </li>
  );
}
