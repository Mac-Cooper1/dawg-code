/**
 * "Permission needed": what a tool call will run or change, why it asks, and the three answers:
 * allow once, always allow (showing, and optionally editing, the rule that will be saved), and
 * deny with an optional note to dawg.
 */
import type { PermissionRequest, PermissionResponse } from "@dawg/protocol";
import { Fragment, memo, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { agentTitle } from "../lib/agents.ts";
import { displayPath } from "../lib/format.ts";
import { TextWithCode } from "../markdown/index.ts";
import type { PermissionItem } from "../state/types.ts";
import { DiffView } from "../transcript/DiffView.tsx";
import type { TranscriptEnv } from "../transcript/env.ts";
import { SandboxPermissionLine } from "../transcript/Sandbox.tsx";
import { Button } from "../ui/index.ts";
import styles from "./DecisionCard.module.css";
import { DecisionFrame, DecisionRecord, useFocusOnAppear } from "./DecisionFrame.tsx";
import { permissionRecord, savedRules } from "./records.ts";

/** Where "always allow" saves its rule (the project's personal settings). */
export const LOCAL_SETTINGS_FILE = ".dawg/settings.local.json";

function joinWithAnd(items: readonly ReactNode[]): ReactNode[] {
  return items.map((node, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: positional list of rules
    <Fragment key={index}>
      {index > 0 && (index === items.length - 1 ? " and " : ", ")}
      {node}
    </Fragment>
  ));
}

/** "Asked by the Explore agent: Find the config loader", for a request a subagent raised. */
function AgentLine({ request }: { request: PermissionRequest }) {
  if (!request.agent) return null;
  return (
    <p className={styles.agent}>
      <span className="vh">Asked by </span>
      {agentTitle(request.agent)}
    </p>
  );
}

/** The card's accessible name: what it asks, and which agent asks when one does. */
function cardLabel(prefix: string, request: PermissionRequest): string {
  const who = request.agent ? ` for the ${agentTitle(request.agent)}` : "";
  return `${prefix}${who}: ${request.title}`;
}

/** What will run or change: the command, the diff, or the call's input. */
function Preview({ request, env }: { request: PermissionRequest; env: TranscriptEnv }) {
  const command = request.input.command;
  if (request.toolName === "Bash" && typeof command === "string") {
    return <pre className={styles.command}>{command}</pre>;
  }
  // WebFetch: the whole address it will fetch, so the person sees exactly where it goes.
  const url = request.input.url;
  if (request.toolName === "WebFetch" && typeof url === "string") {
    return <pre className={styles.command}>{url}</pre>;
  }
  const display = request.display;
  if (display?.kind === "diff") {
    const path = displayPath(display.filePath, env.cwd, env.homeDir);
    return (
      <div className={styles.change}>
        <div className={styles.changePath}>
          <span title={display.filePath}>
            {path}
            {display.created ? " (new file)" : ""}
          </span>
          <span className={styles.add}>+{display.additions}</span>
          <span className={styles.del}>−{display.deletions}</span>
        </div>
        <DiffView hunks={display.hunks} compact />
      </div>
    );
  }
  return <pre className={styles.command}>{JSON.stringify(request.input, null, 2)}</pre>;
}

/** "Always allow saves the rule Bash(uv add --dev *) to .dawg/settings.local.json." */
function RuleLine({
  suggestions,
  editing,
  rules,
  onEdit,
  onChange,
}: {
  suggestions: readonly string[];
  editing: boolean;
  rules: readonly string[];
  onEdit(): void;
  onChange(index: number, value: string): void;
}) {
  const inputId = useId();
  if (suggestions.length === 0) {
    return <p className={styles.hint}>Always allow applies to this session.</p>;
  }
  if (!editing) {
    return (
      <p className={styles.hint}>
        Always allow saves the {suggestions.length === 1 ? "rule" : "rules"}{" "}
        {joinWithAnd(
          suggestions.map((rule) => (
            <code key={rule} className={styles.rule}>
              {rule}
            </code>
          )),
        )}{" "}
        to {LOCAL_SETTINGS_FILE}.{" "}
        <button type="button" className={styles.link} onClick={onEdit}>
          Edit the rule first
        </button>
      </p>
    );
  }
  return (
    <div className={styles.stack}>
      {rules.map((rule, index) => {
        const id = `${inputId}-${index}`;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: one field per suggested rule, in order
          <div key={index} className={styles.stack}>
            <label className={styles.fieldLabel} htmlFor={id}>
              {rules.length === 1 ? "Rule to save" : `Rule ${index + 1} to save`}
            </label>
            <input
              id={id}
              className={`${styles.input} ${styles.ruleInput}`}
              value={rule}
              spellCheck={false}
              onChange={(event) => onChange(index, event.target.value)}
            />
          </div>
        );
      })}
      <p className={styles.hint}>Always allow saves the edited rule to {LOCAL_SETTINGS_FILE}.</p>
    </div>
  );
}

/** The card while it waits for an answer. */
function PendingPermission({
  item,
  env,
  autoFocus,
}: {
  item: PermissionItem;
  env: TranscriptEnv;
  autoFocus: boolean;
}) {
  const { request } = item;
  const [mode, setMode] = useState<"main" | "deny">("main");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [rules, setRules] = useState<string[]>(() => [...request.suggestions]);
  const [sent, setSent] = useState(false);
  const allowRef = useRef<HTMLButtonElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const noteId = useId();
  useFocusOnAppear(allowRef, autoFocus);

  const respond = (response: PermissionResponse) => {
    if (sent) return;
    setSent(true);
    env.respondPermission(item.requestId, response);
  };
  const allowOnce = () => respond({ behavior: "allow", scope: "once" });
  const allowAlways = () =>
    respond({
      behavior: "allow",
      scope: "always",
      rules: editing ? rules.map((rule) => rule.trim()).filter((rule) => rule !== "") : rules,
    });
  // Moving between the actions and the note keeps focus with the person: into the note field,
  // and back onto "Deny…".
  const focusAfterSwitch = useRef(false);
  useEffect(() => {
    if (!focusAfterSwitch.current) return;
    focusAfterSwitch.current = false;
    (mode === "deny" ? noteRef.current : denyRef.current)?.focus();
  }, [mode]);
  const openDeny = () => {
    focusAfterSwitch.current = true;
    setMode("deny");
  };
  const back = () => {
    focusAfterSwitch.current = true;
    setMode("main");
  };
  const deny = () => {
    const message = note.trim();
    respond(message ? { behavior: "deny", message } : { behavior: "deny" });
  };

  const shortcuts =
    mode === "main"
      ? { primary: allowOnce, secondary: allowAlways, escape: openDeny }
      : { primary: null, secondary: deny, escape: back };

  return (
    <DecisionFrame
      icon="shield"
      heading="Permission needed"
      aside={<span className={styles.aside}>{request.toolName}</span>}
      label={cardLabel("Permission needed", request)}
      shortcuts={sent ? null : shortcuts}
    >
      <AgentLine request={request} />
      <p className={styles.title}>
        <TextWithCode text={request.title} />
      </p>
      <Preview request={request} env={env} />
      <SandboxPermissionLine sandbox={request.sandbox} />
      {request.reason && (
        <p className={styles.why}>
          <TextWithCode text={request.reason} />
        </p>
      )}
      {mode === "main" ? (
        <div className={styles.stack}>
          <div className={styles.actions}>
            <Button
              ref={allowRef}
              variant="primary"
              kbd="⏎"
              aria-keyshortcuts="Enter"
              disabled={sent}
              onClick={allowOnce}
            >
              Allow once
            </Button>
            <Button kbd="⌘⏎" aria-keyshortcuts="Meta+Enter" disabled={sent} onClick={allowAlways}>
              Always allow
            </Button>
            <Button
              ref={denyRef}
              variant="danger"
              kbd="esc"
              aria-keyshortcuts="Escape"
              disabled={sent}
              onClick={openDeny}
            >
              Deny…
            </Button>
          </div>
          <RuleLine
            suggestions={request.suggestions}
            editing={editing}
            rules={rules}
            onEdit={() => setEditing(true)}
            onChange={(index, value) =>
              setRules((current) => current.map((rule, i) => (i === index ? value : rule)))
            }
          />
        </div>
      ) : (
        <div className={styles.stack}>
          <label className={styles.fieldLabel} htmlFor={noteId}>
            Tell dawg why, or what to do instead (optional)
          </label>
          <textarea
            ref={noteRef}
            id={noteId}
            className={styles.field}
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className={styles.actions}>
            <Button
              variant="danger"
              kbd="⌘⏎"
              aria-keyshortcuts="Meta+Enter"
              disabled={sent}
              onClick={deny}
            >
              {note.trim() ? "Deny and send the note" : "Deny"}
            </Button>
            <Button variant="ghost" kbd="esc" aria-keyshortcuts="Escape" onClick={back}>
              Back
            </Button>
          </div>
        </div>
      )}
    </DecisionFrame>
  );
}

/** The card shown again after it was answered: read-only, with the answer marked. */
function AnsweredPermission({ item, env }: { item: PermissionItem; env: TranscriptEnv }) {
  const { request, response } = item;
  const chosen =
    response === null
      ? null
      : response.behavior === "deny"
        ? "deny"
        : response.scope === "always"
          ? "always"
          : "once";
  const rules = savedRules(item);
  return (
    <DecisionFrame
      icon="shield"
      heading="Permission"
      aside={<span className={styles.aside}>{request.toolName}</span>}
      label={cardLabel("Permission, answered", request)}
      shortcuts={null}
      readOnly
    >
      <AgentLine request={request} />
      <p className={styles.title}>
        <TextWithCode text={request.title} />
      </p>
      <Preview request={request} env={env} />
      <SandboxPermissionLine sandbox={request.sandbox} />
      {request.reason && (
        <p className={styles.why}>
          <TextWithCode text={request.reason} />
        </p>
      )}
      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled
          aria-pressed={chosen === "once"}
          className={chosen === "once" ? styles.chosen : undefined}
        >
          Allow once
        </Button>
        <Button
          disabled
          aria-pressed={chosen === "always"}
          className={chosen === "always" ? styles.chosen : undefined}
        >
          Always allow
        </Button>
        <Button
          variant="danger"
          disabled
          aria-pressed={chosen === "deny"}
          className={chosen === "deny" ? styles.chosen : undefined}
        >
          Deny
        </Button>
      </div>
      {chosen === "always" && rules.length > 0 && (
        <p className={styles.hint}>
          Saved to {LOCAL_SETTINGS_FILE}:{" "}
          {joinWithAnd(
            rules.map((rule) => (
              <code key={rule} className={styles.rule}>
                {rule}
              </code>
            )),
          )}
        </p>
      )}
      {response?.behavior === "deny" && response.message && (
        <p className={styles.quote}>{response.message}</p>
      )}
    </DecisionFrame>
  );
}

export interface PermissionCardProps {
  item: PermissionItem;
  /** The person asked to see the answered card again. */
  shownAgain: boolean;
  /** Focus the primary action when the card appears (the composer is empty). */
  autoFocus: boolean;
  env: TranscriptEnv;
}

export const PermissionCard = memo(function PermissionCard({
  item,
  shownAgain,
  autoFocus,
  env,
}: PermissionCardProps) {
  if (item.state === "pending")
    return <PendingPermission item={item} env={env} autoFocus={autoFocus} />;
  return (
    <div className={styles.answered}>
      <DecisionRecord
        icon="shield"
        text={
          item.request.agent
            ? `${permissionRecord(item)} · ${agentTitle(item.request.agent)}`
            : permissionRecord(item)
        }
        shown={shownAgain}
        onShowAgain={(shown) => env.showCardAgain(item.requestId, shown)}
      />
      {shownAgain && <AnsweredPermission item={item} env={env} />}
    </div>
  );
});
