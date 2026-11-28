/**
 * Settings → Permissions → Sandbox (Phase 4): turn the sandbox on, let sandboxed commands run
 * without asking, allow or forbid retrying a blocked command outside it, edit the hosts sandboxed
 * commands may reach, and see the commands the settings exclude from it. Changes go to one of
 * dawg's settings files, chosen here; what new sessions get is every file merged, shown above.
 */
import { Switch } from "radix-ui";
import { type FormEvent, useEffect, useId, useState } from "react";
import type {
  PermissionScope,
  PermissionSettingsFile,
  PermissionSettingsState,
  PermissionsWriteInput,
  SandboxFileSettings,
} from "../../shared/bridge.ts";
import { shortenPath } from "../lib/format.ts";
import { Button, Icon, IconButton } from "../ui/index.ts";
import switches from "./GeneralPage.module.css";
import styles from "./PermissionsPage.module.css";
import own from "./SandboxSection.module.css";

type Change = Omit<PermissionsWriteInput, "scope" | "projectDir">;

const SCOPE_TITLES: Record<PermissionScope, string> = {
  local: "Personal for this project",
  project: "Shared with the project",
  user: "Yours everywhere",
};

export interface SandboxSectionProps {
  state: PermissionSettingsState;
  homeDir: string;
  save(
    scope: PermissionScope,
    change: (file: PermissionSettingsFile) => Change | null,
  ): Promise<boolean>;
}

const EMPTY: SandboxFileSettings = {
  enabled: null,
  autoAllowBashIfSandboxed: null,
  allowUnsandboxedCommands: null,
  allowedDomains: [],
  excludedCommands: [],
};

function SwitchRow(props: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  const switchId = useId();
  const titleId = useId();
  const descriptionId = useId();
  return (
    <div className={switches.switchRow}>
      {/* The whole text toggles the switch; its name stays the title alone. */}
      <label htmlFor={switchId} className={switches.switchText}>
        <span id={titleId} className={switches.switchTitle}>
          {props.title}
        </span>
        <span id={descriptionId} className={switches.switchDescription}>
          {props.description}
        </span>
      </label>
      <Switch.Root
        id={switchId}
        className={switches.switch}
        checked={props.checked}
        disabled={props.disabled === true}
        onCheckedChange={props.onChange}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <Switch.Thumb className={switches.thumb} />
      </Switch.Root>
    </div>
  );
}

export function SandboxSection(props: SandboxSectionProps) {
  const { state, homeDir } = props;
  const headingId = useId();
  const scopeId = useId();
  const writable = state.files.filter((file) => file.origin === "dawg");
  const defaultScope: PermissionScope = state.projectDir === null ? "user" : "local";
  const [scope, setScope] = useState<PermissionScope>(defaultScope);
  // A scope the project picker took away falls back to the default.
  useEffect(() => {
    if (!writable.some((file) => file.scope === scope)) setScope(defaultScope);
  }, [writable, scope, defaultScope]);
  const sandbox = state.sandbox;
  if (sandbox === undefined) return null;
  const file = writable.find((f) => f.scope === scope);
  const mine = file?.sandbox ?? EMPTY;
  const editable = file?.writable === true;
  const write = (change: NonNullable<Change["sandbox"]>) =>
    props.save(scope, () => ({ sandbox: change }));
  const enabledBy =
    sandbox.enabledBy === null
      ? null
      : sandbox.enabledBy === "<command line>"
        ? "the command line"
        : shortenPath(sandbox.enabledBy, homeDir);
  const otherDomains = sandbox.allowedDomains.filter((d) => !mine.allowedDomains.includes(d));

  return (
    <section className={styles.scope} aria-labelledby={headingId}>
      <div className={styles.scopeHeader}>
        <h2 id={headingId} className={styles.h2}>
          Sandbox
        </h2>
      </div>
      <p className={styles.scopeLead}>
        Shell commands in the sandbox can write only in the working folders and temp, and reach only
        the hosts listed here. A command that needs more is asked about before it runs outside the
        sandbox.
      </p>
      {!sandbox.available && (
        <p className={own.warning} role="note">
          <Icon name="alert" size={12} />
          <span>
            {sandbox.unavailableReason ?? "The sandbox cannot run here."} With it on, commands run
            without it.
          </span>
        </p>
      )}
      <div className={styles.card}>
        <p className={own.status} aria-live="polite">
          <Icon name="shield" size={12} />
          <span>
            {sandbox.enabled
              ? `On for new sessions${enabledBy === null ? "" : `, set by ${enabledBy}`}.`
              : enabledBy === null
                ? "Off: no settings file turns it on."
                : `Off, set by ${enabledBy}.`}
          </span>
        </p>
        <div className={styles.modeRow}>
          <label className={styles.fieldLabel} htmlFor={scopeId}>
            Save changes to
          </label>
          <select
            id={scopeId}
            className={styles.select}
            value={scope}
            onChange={(event) => setScope(event.target.value as PermissionScope)}
          >
            {writable.map((f) => (
              <option key={f.scope} value={f.scope}>
                {SCOPE_TITLES[f.scope]} ({shortenPath(f.path, homeDir)})
              </option>
            ))}
          </select>
        </div>
        {!editable && file !== undefined && (
          <p className={styles.fileNote}>dawg cannot change this file until it is fixed by hand.</p>
        )}
        <div className={switches.switches}>
          <SwitchRow
            title="Run shell commands in the sandbox"
            description={
              mine.enabled === null
                ? "This file leaves it to the others."
                : mine.enabled
                  ? "This file turns it on."
                  : "This file turns it off."
            }
            checked={mine.enabled ?? sandbox.enabled}
            disabled={!editable}
            onChange={(checked) => void write({ enabled: checked })}
          />
          <SwitchRow
            title="Run sandboxed commands without asking"
            description={
              scope === "project"
                ? "Only your own settings can turn this on, not a project's shared file."
                : "Deny rules and rules that ask about a command still apply."
            }
            checked={mine.autoAllowBashIfSandboxed ?? sandbox.autoAllowBashIfSandboxed}
            disabled={!editable || (scope === "project" && mine.autoAllowBashIfSandboxed !== true)}
            onChange={(checked) => void write({ autoAllowBashIfSandboxed: checked })}
          />
          <SwitchRow
            title="Offer to retry a blocked command outside the sandbox"
            description="You are asked before it runs without the sandbox."
            checked={mine.allowUnsandboxedCommands ?? sandbox.allowUnsandboxedCommands}
            disabled={!editable}
            onChange={(checked) => void write({ allowUnsandboxedCommands: checked })}
          />
        </div>
        <DomainList
          domains={mine.allowedDomains}
          others={otherDomains}
          editable={editable}
          onChange={(domains) => write({ allowedDomains: domains })}
        />
        <div className={styles.list}>
          <div className={styles.listHeader}>
            <h3 className={styles.h3}>
              Excluded commands
              <span className={styles.count}>{sandbox.excludedCommands.length}</span>
            </h3>
            <span className={styles.muted}>
              Run outside the sandbox, after the usual permission check. Set in{" "}
              <code>sandbox.excludedCommands</code>.
            </span>
          </div>
          {sandbox.excludedCommands.length === 0 ? (
            <p className={styles.none}>None.</p>
          ) : (
            <ul className={styles.rules} aria-label="Excluded commands">
              {sandbox.excludedCommands.map((command) => (
                <li key={command} className={styles.rule}>
                  <code className={styles.ruleText}>{command}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** The hosts this file allows, with remove on each and a field that adds one. */
function DomainList(props: {
  domains: readonly string[];
  others: readonly string[];
  editable: boolean;
  onChange(domains: string[]): Promise<boolean>;
}) {
  const headingId = useId();
  const messageId = useId();
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const domain = value.trim().toLowerCase();
  const duplicate = domain !== "" && props.domains.includes(domain);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (domain === "" || duplicate) return;
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(domain)) {
      setMessage("Type the host name alone, such as github.com.");
      return;
    }
    if (await props.onChange([...props.domains, domain])) {
      setValue("");
      setMessage(null);
    }
  };

  return (
    <div className={styles.list} data-list="allow">
      <div className={styles.listHeader}>
        <h3 id={headingId} className={styles.h3}>
          Allowed hosts
          <span className={styles.count}>{props.domains.length}</span>
        </h3>
        <span className={styles.muted}>
          Sandboxed commands reach these and nothing else. <code>*.example.com</code> covers its
          subdomains; <code>:443</code> limits a host to one port.
        </span>
      </div>
      {props.domains.length === 0 ? (
        <p className={styles.none}>None in this file.</p>
      ) : (
        <ul className={styles.rules} aria-labelledby={headingId}>
          {props.domains.map((d) => (
            <li key={d} className={styles.rule}>
              <code className={styles.ruleText}>{d}</code>
              {props.editable && (
                <span className={styles.ruleActions}>
                  <IconButton
                    icon="trash"
                    size="sm"
                    label={`Remove ${d}`}
                    onClick={() => void props.onChange(props.domains.filter((x) => x !== d))}
                  />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {props.others.length > 0 && (
        <p className={styles.muted}>Also allowed by other files: {props.others.join(", ")}.</p>
      )}
      {props.editable && (
        <form className={styles.add} onSubmit={(event) => void submit(event)}>
          <div className={styles.addRow}>
            <input
              className={styles.input}
              aria-label="Add an allowed host"
              aria-invalid={message !== null || duplicate}
              aria-describedby={messageId}
              placeholder="registry.npmjs.org"
              value={value}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              onChange={(event) => {
                setValue(event.target.value);
                setMessage(null);
              }}
            />
            <Button type="submit" size="sm" disabled={domain === "" || duplicate}>
              Add
            </Button>
          </div>
          <p id={messageId} className={styles.inputMessage} aria-live="polite">
            {duplicate ? "Already in this list." : message}
          </p>
        </form>
      )}
    </div>
  );
}
