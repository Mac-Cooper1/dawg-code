/**
 * Settings → MCP servers: the servers a project's sessions get (a session's own aside), each with
 * where it is defined, how it connects, its state (connected, starting, failed and why, waiting
 * for approval or sign-in, off), its tools, a restart button and a switch to turn it off. Claude
 * Code's own servers (`~/.claude.json`) are never started from there: "Import…" shows what
 * would be copied into `~/.dawg/mcp.json`, values that may be secrets named, and copies only
 * when the person says so (spec, MCP).
 */
import type { McpImportPlan, McpServerInfo, McpServerState } from "@dawg/protocol";
import { Switch } from "radix-ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { basename, shortenPath } from "../lib/format.ts";
import { sourceLabel } from "../lib/hooks.ts";
import type { McpListing } from "../state/types.ts";
import { Button, ConfirmDialog, Icon, IconButton, Tag, type TagTone } from "../ui/index.ts";
import styles from "./McpPage.module.css";
import type { PermissionsProject } from "./PermissionsPage.tsx";
import settingsStyles from "./Settings.module.css";

const STATE_LABEL: Record<McpServerState, string> = {
  connected: "Connected",
  starting: "Starting",
  failed: "Failed",
  "needs-approval": "Waits for your approval",
  "needs-sign-in": "Needs sign-in",
  off: "Off",
};

const STATE_TONE: Record<McpServerState, TagTone> = {
  connected: "green",
  starting: "accent",
  failed: "red",
  "needs-approval": "amber",
  "needs-sign-in": "amber",
  off: "neutral",
};

const TRANSPORT_LABEL = { stdio: "Local command", http: "HTTP", sse: "SSE" } as const;

/** How often the list is read again while a server is starting or about to try again. */
const REFRESH_MS = 1_500;

export interface McpPageProps {
  /** The projects in the sidebar, in its order. */
  projects: readonly PermissionsProject[];
  /** The project shown first (the selected session's), or null for only the person's servers. */
  initialProject: string | null;
  homeDir: string;
  listMcpServers(projectDir: string | null): Promise<McpListing | { error: string }>;
  restartMcpServer(projectDir: string | null, name: string): Promise<McpServerInfo | null>;
  setMcpServerEnabled(projectDir: string | null, name: string, enabled: boolean): Promise<boolean>;
  previewMcpImport(): Promise<McpImportPlan | { error: string }>;
  importMcpServers(hash: string): Promise<{ imported: number; path: string } | { error: string }>;
  /** Opens the project trust dialog. */
  onReview(projectDir: string): void;
}

/** True while the list may change by itself: a server starting or waiting to try again. */
function settling(listing: McpListing): boolean {
  return listing.servers.some(
    (s) => s.state === "starting" || (s.state === "failed" && /tries again/.test(s.reason ?? "")),
  );
}

export function McpPage(props: McpPageProps) {
  const { homeDir, listMcpServers, restartMcpServer, setMcpServerEnabled } = props;
  const projectId = useId();
  const [picked, setPicked] = useState(false);
  const [projectDir, setProjectDir] = useState<string | null>(props.initialProject);
  const [listing, setListing] = useState<McpListing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [importing, setImporting] = useState<McpImportPlan | null>(null);
  const shown = useRef<string | null>(projectDir);
  shown.current = projectDir;
  /** Requests on their way: their answers must not be overwritten by an older listing. */
  const busy = useRef(0);

  useEffect(() => {
    if (!picked) setProjectDir(props.initialProject);
  }, [picked, props.initialProject]);

  const load = useCallback(
    async (dir: string | null) => {
      const result = await listMcpServers(dir);
      if (shown.current !== dir || busy.current > 0) return;
      if ("error" in result) {
        setProblem(`Could not list the MCP servers: ${result.error}`);
        return;
      }
      setProblem(null);
      setListing(result);
    },
    [listMcpServers],
  );

  useEffect(() => {
    void load(projectDir);
  }, [load, projectDir]);

  // Files edited elsewhere, and approvals given in the dialog, show when the window comes back.
  useEffect(() => {
    const refresh = () => void load(shown.current);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);

  // A server starting (or about to try again) is followed until it settles.
  const loaded = listing !== null && listing.projectDir === projectDir;
  const following = loaded && settling(listing);
  useEffect(() => {
    if (!following) return;
    const timer = setInterval(() => void load(shown.current), REFRESH_MS);
    return () => clearInterval(timer);
  }, [following, load]);

  const replace = useCallback((server: McpServerInfo) => {
    setListing((current) =>
      current === null
        ? current
        : {
            ...current,
            servers: current.servers.map((s) => (s.name === server.name ? server : s)),
          },
    );
  }, []);

  const restart = useCallback(
    async (server: McpServerInfo) => {
      const dir = shown.current;
      replace({ ...server, state: "starting", reason: null });
      busy.current += 1;
      try {
        const next = await restartMcpServer(dir, server.name);
        if (next !== null && shown.current === dir) replace(next);
      } finally {
        busy.current -= 1;
      }
      void load(dir);
    },
    [load, replace, restartMcpServer],
  );

  const toggle = useCallback(
    async (server: McpServerInfo, enabled: boolean) => {
      const dir = shown.current;
      // At once, so the switch follows the hand; the listing says what happened after.
      replace({ ...server, enabled });
      busy.current += 1;
      try {
        const saved = await setMcpServerEnabled(dir, server.name, enabled);
        if (!saved) replace(server);
      } finally {
        busy.current -= 1;
      }
      void load(dir);
    },
    [load, replace, setMcpServerEnabled],
  );

  const openImport = useCallback(async () => {
    setMessage(null);
    const plan = await props.previewMcpImport();
    if ("error" in plan) {
      setProblem(`Could not read Claude Code’s servers: ${plan.error}`);
      return;
    }
    setImporting(plan);
  }, [props.previewMcpImport]);

  const confirmImport = useCallback(async () => {
    const plan = importing;
    setImporting(null);
    if (plan?.hash == null) return;
    const result = await props.importMcpServers(plan.hash);
    if ("error" in result) {
      setProblem(`Nothing was imported: ${result.error}`);
      return;
    }
    setMessage(
      `Copied ${result.imported === 1 ? "1 server" : `${result.imported} servers`} into ${shortenPath(result.path, homeDir)}. Sessions opened from now on start them.`,
    );
    void load(shown.current);
  }, [homeDir, importing, load, props.importMcpServers]);

  const waiting = loaded && listing.servers.some((s) => s.state === "needs-approval");
  const projectChoices =
    projectDir !== null && !props.projects.some((p) => p.dir === projectDir)
      ? [{ dir: projectDir, name: basename(projectDir) }, ...props.projects]
      : props.projects;
  const copies = importing?.items.filter((item) => item.action === "copy") ?? [];

  return (
    <div className={styles.page}>
      <h1 className={settingsStyles.h1}>MCP servers</h1>
      <p className={settingsStyles.lead}>
        Programs and services that give sessions more tools, as in Claude Code. A project’s{" "}
        <code>.mcp.json</code> servers start once you approve the project’s code; yours are in{" "}
        <code>~/.dawg/mcp.json</code>.
      </p>
      <p className={settingsStyles.note}>
        A switch turns one server off for you alone. dawg keeps it in its own data folder, so the
        configuration files are never changed.
      </p>

      {problem !== null && (
        <p className={styles.notice} role="alert">
          <Icon name="alert" size={14} />
          <span className={styles.noticeText}>{problem}</span>
          <IconButton icon="close" size="sm" label="Dismiss" onClick={() => setProblem(null)} />
        </p>
      )}
      {message !== null && (
        <p className={styles.done} role="status">
          <Icon name="check" size={14} />
          <span className={styles.noticeText}>{message}</span>
          <IconButton icon="close" size="sm" label="Dismiss" onClick={() => setMessage(null)} />
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
          <option value="">No project: only your servers</option>
        </select>
      </div>

      {!loaded ? (
        problem === null && (
          <p className={settingsStyles.note} aria-live="polite">
            Reading the MCP configuration…
          </p>
        )
      ) : (
        <>
          {listing.importable > 0 && (
            <div className={styles.importRow}>
              <Icon name="download" size={14} />
              <span className={styles.importText}>
                Claude Code’s own settings hold{" "}
                {listing.importable === 1 ? "a server" : `${listing.importable} servers`} dawg has
                not imported. dawg never starts them from there.
              </span>
              <Button size="sm" onClick={() => void openImport()}>
                Import…
              </Button>
            </div>
          )}
          {waiting && projectDir !== null && (
            <div className={styles.waiting}>
              <Icon name="shield" size={14} />
              <span className={styles.waitingText}>
                The project’s servers wait for your approval before they start.
              </span>
              <Button size="sm" onClick={() => props.onReview(projectDir)}>
                Review
              </Button>
            </div>
          )}
          {listing.servers.length === 0 ? (
            <div className={settingsStyles.empty}>
              <p className={settingsStyles.emptyTitle}>No MCP servers</p>
              <p className={settingsStyles.emptyText}>
                Add servers to the project’s <code>.mcp.json</code> or to{" "}
                <code>~/.dawg/mcp.json</code>, in Claude Code’s format.
              </p>
            </div>
          ) : (
            <ul className={styles.list} aria-label="MCP servers">
              {listing.servers.map((server) => (
                <ServerRow
                  key={`${server.scope}:${server.name}`}
                  server={server}
                  homeDir={homeDir}
                  onRestart={() => void restart(server)}
                  onToggle={(enabled) => void toggle(server, enabled)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      <ConfirmDialog
        open={importing !== null}
        onOpenChange={(open) => {
          if (!open) setImporting(null);
        }}
        title={
          copies.length === 0
            ? "Nothing to import"
            : `Import ${copies.length === 1 ? "1 server" : `${copies.length} servers`} from Claude Code?`
        }
        confirmLabel={copies.length === 0 ? "Close" : "Import"}
        onConfirm={() => void confirmImport()}
      >
        {importing !== null && <ImportList plan={importing} homeDir={homeDir} />}
      </ConfirmDialog>
    </div>
  );
}

function ImportList(props: { plan: McpImportPlan; homeDir: string }) {
  const { plan, homeDir } = props;
  return (
    <>
      <p>
        From <code>{shortenPath(plan.from, homeDir)}</code>, which stays as it is, into{" "}
        <code>{shortenPath(plan.to, homeDir)}</code>. The copies can hold keys and tokens; only you
        can read the file.
      </p>
      <ul className={styles.importList} aria-label="What the import copies">
        {plan.items.map((item) => (
          <li key={`${item.project ?? ""}:${item.name}`} className={styles.importItem}>
            <span className={styles.importName}>{item.name}</span>{" "}
            <span className={styles.muted}>
              {item.project === null
                ? "for every project"
                : `for ${shortenPath(item.project, homeDir)}`}
            </span>
            <code className={styles.target}>{item.target}</code>
            {item.action === "skip" ? (
              <span className={styles.skip}>Left out: {item.reason}</span>
            ) : item.secrets.length > 0 ? (
              <span className={styles.secrets}>
                Copies values that may be secrets: {item.secrets.join(", ")}.
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

function ServerRow(props: {
  server: McpServerInfo;
  homeDir: string;
  onRestart(): void;
  onToggle(enabled: boolean): void;
}) {
  const { server } = props;
  const detailId = useId();
  const toolsId = useId();
  const [open, setOpen] = useState(false);
  // "Off" because no session runs it can be started to check it; turned off or kept out cannot.
  const idle = server.state === "off" && server.reason?.startsWith("Not running") === true;
  const canRestart =
    server.enabled &&
    server.transport !== null &&
    (server.state === "connected" || server.state === "failed" || idle);
  const count = server.tools.length;
  return (
    <li className={server.enabled ? styles.row : `${styles.row} ${styles.off}`}>
      <div className={styles.rowMain}>
        <div className={styles.rowHead}>
          <span className={styles.name}>{server.name}</span>
          <Tag tone={STATE_TONE[server.state]}>{STATE_LABEL[server.state]}</Tag>
          {server.transport !== null && <Tag>{TRANSPORT_LABEL[server.transport]}</Tag>}
        </div>
        <div id={detailId} className={styles.rowDetail}>
          <code className={styles.target}>{server.target}</code>
          <p className={styles.source}>
            <code className={styles.path}>{shortenPath(server.source.path, props.homeDir)}</code>
            <span> · {sourceLabel(server.source)}</span>
          </p>
          {server.reason !== null && <p className={styles.reason}>{server.reason}</p>}
          {server.notes.length > 0 && (
            <ul className={styles.notes}>
              {server.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
        {count > 0 && (
          <>
            <button
              type="button"
              className={styles.toolsToggle}
              aria-expanded={open}
              aria-controls={toolsId}
              onClick={() => setOpen((value) => !value)}
            >
              <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
              {count === 1 ? "1 tool" : `${count} tools`}
              {server.prompts > 0 &&
                `, ${server.prompts === 1 ? "1 prompt" : `${server.prompts} prompts`}`}
              {server.resources > 0 &&
                `, ${server.resources === 1 ? "1 resource" : `${server.resources} resources`}`}
            </button>
            {open && (
              <ul id={toolsId} className={styles.tools} aria-label={`${server.name}’s tools`}>
                {server.tools.map((tool) => (
                  <li key={tool.name}>
                    <code className={styles.toolName}>{tool.name}</code>
                    {tool.description !== "" && (
                      <span className={styles.muted}> {tool.description}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <div className={styles.actions}>
        {canRestart && (
          <Button
            size="sm"
            variant="ghost"
            onClick={props.onRestart}
            aria-label={`${idle ? "Start" : "Restart"} ${server.name}`}
          >
            {idle ? "Start" : "Restart"}
          </Button>
        )}
        {server.scope !== "session" && (
          <Switch.Root
            className={styles.switch}
            checked={server.enabled}
            onCheckedChange={props.onToggle}
            aria-label={server.name}
            aria-describedby={detailId}
          >
            <Switch.Thumb className={styles.thumb} />
          </Switch.Root>
        )}
      </div>
    </li>
  );
}
