/**
 * An MCP server's request for input (Phase 4, MCP elicitation), where decision cards appear and
 * labelled with the server that asks:
 *
 * - form mode: one control per field the server asked for, its default filled in, checked with
 *   the protocol's own rules (`elicitationFieldIssue`) when a field is left and on Submit, with
 *   the message next to the field; empty optional fields are left out of the answer;
 * - URL mode: the site and the whole address, opened in the browser only when the person clicks
 *   Open page (never fetched before), which answers "accept".
 *
 * Everything the server wrote (its message, labels, descriptions, choices, the address) is
 * untrusted: drawn as plain text, never as Markdown or a link.
 */
import {
  type ElicitationContent,
  type ElicitationField,
  elicitationFieldIssue,
} from "@dawg/protocol";
import { type FormEvent, memo, type ReactNode, useCallback, useId, useRef, useState } from "react";
import { agentTitle } from "../lib/agents.ts";
import type { ElicitationAnswer, ElicitationItem } from "../state/types.ts";
import type { TranscriptEnv } from "../transcript/env.ts";
import { Button, Icon } from "../ui/index.ts";
import styles from "./DecisionCard.module.css";
import { DecisionFrame, DecisionRecord, useFocusOnAppear } from "./DecisionFrame.tsx";
import own from "./ElicitationCard.module.css";
import { isTextField } from "./keys.ts";
import { elicitationRecord } from "./records.ts";

/** A select with more choices than this is a menu rather than a list of radio buttons. */
const RADIO_LIMIT = 6;
const DATE_TIME_EXAMPLE = "2026-11-27T09:30:00Z";

/** What a control holds: text (strings and numbers as typed), a tick, a choice, or choices. */
type Draft = string | boolean | string[] | null;
type Drafts = Record<string, Draft>;

function initialDraft(field: ElicitationField, given: unknown): Draft {
  switch (field.type) {
    case "string":
      return typeof given === "string" ? given : (field.default ?? "");
    case "number":
    case "integer": {
      const value = typeof given === "number" ? given : field.default;
      return value === null ? "" : String(value);
    }
    case "boolean":
      return typeof given === "boolean" ? given : (field.default ?? false);
    case "select": {
      const value = typeof given === "string" ? given : field.default;
      return field.options.some((o) => o.value === value) ? (value as string) : null;
    }
    case "multiselect": {
      const values = Array.isArray(given) ? given : (field.default ?? []);
      return field.options.map((o) => o.value).filter((v) => values.includes(v));
    }
  }
}

function initialDrafts(fields: readonly ElicitationField[], content: ElicitationContent | null) {
  const out: Drafts = {};
  for (const field of fields) out[field.name] = initialDraft(field, content?.[field.name]);
  return out;
}

/** The value a draft gives the answer, or undefined when the field is left out. */
function answerValue(field: ElicitationField, draft: Draft): unknown {
  switch (field.type) {
    case "string":
      return typeof draft === "string" && draft !== "" ? draft : undefined;
    case "number":
    case "integer": {
      const text = typeof draft === "string" ? draft.trim() : "";
      return text === "" ? undefined : Number(text);
    }
    case "boolean":
      return draft === true;
    case "select":
      return typeof draft === "string" ? draft : undefined;
    case "multiselect":
      return Array.isArray(draft) && draft.length > 0 ? draft : undefined;
  }
}

function issueOf(field: ElicitationField, draft: Draft): string | null {
  const value = answerValue(field, draft);
  if (value === undefined) return field.required ? "This is required." : null;
  return elicitationFieldIssue(field, value);
}

function labelOf(field: ElicitationField): string {
  return field.title ?? field.name;
}

/** The card's accessible name: its heading, and which agent's call asks when one does. */
function cardLabel(heading: string, item: ElicitationItem): string {
  return item.agent ? `${heading} for the ${agentTitle(item.agent)}` : heading;
}

/** "Asked by the booker agent: Book a table", for a request a subagent's call caused. */
function AgentLine({ item }: { item: ElicitationItem }) {
  if (!item.agent) return null;
  return (
    <p className={styles.agent}>
      <span className="vh">Asked by </span>
      {agentTitle(item.agent)}
    </p>
  );
}

/** "example.com"; the address itself when it does not parse. ASCII, so look-alikes show. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

interface FieldProps {
  field: ElicitationField;
  draft: Draft;
  error: string | null;
  readOnly: boolean;
  onChange(draft: Draft): void;
  onBlur(): void;
  /** Takes the field's first control, for focus when the card appears. */
  inputRef?: ((element: HTMLElement | null) => void) | undefined;
}

function FormField({ field, draft, error, readOnly, onChange, onBlur, inputRef }: FieldProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const help =
    field.type === "string" && field.format === "date-time"
      ? [field.description, `A date and time, such as ${DATE_TIME_EXAMPLE}.`]
          .filter(Boolean)
          .join(" ")
      : field.description;
  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(" ");
  const common = {
    "aria-describedby": describedBy === "" ? undefined : describedBy,
    "aria-invalid": error ? true : undefined,
    "aria-required": field.required ? true : undefined,
  } as const;
  // Seen beside the label; controls say it with aria-required, so it stays out of their name.
  // A group of checkboxes cannot, so it says it in its description instead.
  const required = field.required && (
    <span className={own.required} aria-hidden="true">
      required
    </span>
  );
  const label = (
    <div className={own.labelRow}>
      <span id={labelId} className={own.label}>
        {labelOf(field)}
      </span>
      {required}
    </div>
  );

  let control: ReactNode;
  switch (field.type) {
    case "string":
    case "number":
    case "integer": {
      const isNumber = field.type !== "string";
      const type = isNumber
        ? "number"
        : field.format === "email"
          ? "email"
          : field.format === "uri"
            ? "url"
            : field.format === "date"
              ? "date"
              : "text";
      control = (
        <input
          ref={inputRef}
          id={id}
          className={isNumber ? `${styles.input} ${own.number}` : styles.input}
          type={type}
          value={typeof draft === "string" ? draft : ""}
          readOnly={readOnly}
          placeholder={
            field.type === "string" && field.format === "date-time" ? DATE_TIME_EXAMPLE : undefined
          }
          inputMode={
            field.type === "integer" ? "numeric" : field.type === "number" ? "decimal" : undefined
          }
          step={field.type === "integer" ? 1 : field.type === "number" ? "any" : undefined}
          min={isNumber && field.minimum !== null ? field.minimum : undefined}
          max={isNumber && field.maximum !== null ? field.maximum : undefined}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          {...common}
        />
      );
      return (
        <div className={own.field} data-field={field.name}>
          <div className={own.labelRow}>
            <label htmlFor={id} className={own.label}>
              {labelOf(field)}
            </label>
            {required}
          </div>
          {help && (
            <p id={helpId} className={own.help}>
              {help}
            </p>
          )}
          {control}
          {error && (
            <p id={errorId} className={styles.error}>
              {error}
            </p>
          )}
        </div>
      );
    }
    case "boolean":
      return (
        <div className={own.field} data-field={field.name}>
          <label className={styles.option}>
            <input
              ref={inputRef}
              className={styles.nativeInput}
              type="checkbox"
              checked={draft === true}
              disabled={readOnly}
              onChange={(event) => onChange(event.target.checked)}
              onBlur={onBlur}
              {...common}
            />
            <span className={`${styles.mark} ${styles.markSquare}`} aria-hidden="true">
              {draft === true && <Icon name="check" size={12} strokeWidth={2.2} />}
            </span>
            <span className={styles.optionText}>
              <span className={styles.optionLabel}>{labelOf(field)}</span>
            </span>
            {required}
          </label>
          {help && (
            <p id={helpId} className={own.help}>
              {help}
            </p>
          )}
          {error && (
            <p id={errorId} className={styles.error}>
              {error}
            </p>
          )}
        </div>
      );
    case "select":
      if (field.options.length > RADIO_LIMIT) {
        control = (
          <select
            ref={inputRef}
            id={id}
            className={own.select}
            value={typeof draft === "string" ? draft : ""}
            disabled={readOnly}
            aria-labelledby={labelId}
            onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
            onBlur={onBlur}
            {...common}
          >
            <option value="">Choose…</option>
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.title ?? option.value}
              </option>
            ))}
          </select>
        );
      } else {
        control = (
          <div className={styles.options} role="radiogroup" aria-labelledby={labelId} {...common}>
            {field.options.map((option, index) => (
              <label key={option.value} className={styles.option}>
                <input
                  ref={index === 0 ? inputRef : undefined}
                  className={styles.nativeInput}
                  type="radio"
                  name={id}
                  value={option.value}
                  checked={draft === option.value}
                  disabled={readOnly}
                  onChange={() => onChange(option.value)}
                  onBlur={onBlur}
                />
                <span className={styles.mark} aria-hidden="true" />
                <span className={styles.optionText}>
                  <span className={styles.optionLabel}>{option.title ?? option.value}</span>
                </span>
              </label>
            ))}
          </div>
        );
      }
      break;
    case "multiselect": {
      const picked = Array.isArray(draft) ? draft : [];
      control = (
        <fieldset
          className={`${styles.options} ${styles.fieldset}`}
          aria-labelledby={labelId}
          aria-describedby={
            [common["aria-describedby"], field.required ? `${id}-required` : null]
              .filter(Boolean)
              .join(" ") || undefined
          }
        >
          {field.required && (
            <span id={`${id}-required`} hidden>
              Required.
            </span>
          )}
          {field.options.map((option, index) => {
            const checked = picked.includes(option.value);
            return (
              <label key={option.value} className={styles.option}>
                <input
                  ref={index === 0 ? inputRef : undefined}
                  className={styles.nativeInput}
                  type="checkbox"
                  value={option.value}
                  checked={checked}
                  disabled={readOnly}
                  onChange={() => {
                    const next = checked
                      ? picked.filter((v) => v !== option.value)
                      : [...picked, option.value];
                    // In the options' order, whatever order they were picked in.
                    onChange(field.options.map((o) => o.value).filter((v) => next.includes(v)));
                  }}
                  onBlur={onBlur}
                />
                <span className={`${styles.mark} ${styles.markSquare}`} aria-hidden="true">
                  {checked && <Icon name="check" size={12} strokeWidth={2.2} />}
                </span>
                <span className={styles.optionText}>
                  <span className={styles.optionLabel}>{option.title ?? option.value}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
      );
      break;
    }
  }
  return (
    <div className={own.field} data-field={field.name}>
      {label}
      {help && (
        <p id={helpId} className={own.help}>
          {help}
        </p>
      )}
      {control}
      {error && (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}

interface FormProps {
  item: ElicitationItem;
  env: TranscriptEnv;
  autoFocus: boolean;
  readOnly: boolean;
}

function ElicitationForm({ item, env, autoFocus, readOnly }: FormProps) {
  const { fields } = item;
  const [drafts, setDrafts] = useState<Drafts>(() =>
    initialDrafts(fields, readOnly ? (item.response?.content ?? null) : null),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [sent, setSent] = useState(false);
  const firstRef = useRef<HTMLElement | null>(null);
  const takeFirst = useCallback((element: HTMLElement | null) => {
    firstRef.current = element;
  }, []);
  const submitRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useFocusOnAppear(fields.length > 0 ? firstRef : submitRef, autoFocus && !readOnly);

  const setError = (name: string, message: string | null) =>
    setErrors((current) => {
      if ((current[name] ?? null) === message) return current;
      const next = { ...current };
      if (message === null) delete next[name];
      else next[name] = message;
      return next;
    });

  const respond = (answer: ElicitationAnswer) => {
    if (sent || readOnly) return;
    setSent(true);
    env.respondElicitation(item.requestId, answer);
  };

  const submit = () => {
    if (sent || readOnly) return;
    const found: Record<string, string> = {};
    const content: ElicitationContent = {};
    for (const field of fields) {
      const draft = drafts[field.name] ?? null;
      const issue = issueOf(field, draft);
      if (issue !== null) found[field.name] = issue;
      const value = answerValue(field, draft);
      if (value !== undefined) content[field.name] = value as ElicitationContent[string];
    }
    setAttempted(true);
    setErrors(found);
    const first = fields.find((field) => found[field.name] !== undefined);
    if (first !== undefined) {
      // To the first field that needs a change, where its message is read out.
      submitRef.current
        ?.closest("section")
        ?.querySelector<HTMLElement>(
          `[data-field="${CSS.escape(first.name)}"] :is(input, select):not(:disabled)`,
        )
        ?.focus();
      return;
    }
    respond({ action: "accept", content });
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };
  /** Esc in a text field only leaves it (onto Cancel), so what was typed is not lost. */
  const leaveOrCancel = () => {
    if (isTextField(document.activeElement)) cancelRef.current?.focus();
    else respond({ action: "cancel" });
  };

  const heading = readOnly ? `${item.server} asked for input` : `${item.server} asks for input`;
  return (
    <DecisionFrame
      icon="server"
      heading={heading}
      label={cardLabel(heading, item)}
      shortcuts={
        readOnly || sent ? null : { primary: submit, secondary: submit, escape: leaveOrCancel }
      }
      readOnly={readOnly}
    >
      <AgentLine item={item} />
      {item.message.trim() !== "" && <p className={own.message}>{item.message}</p>}
      <form className={own.form} noValidate onSubmit={onSubmit}>
        {fields.map((field, index) => (
          <FormField
            key={field.name}
            field={field}
            draft={drafts[field.name] ?? null}
            error={errors[field.name] ?? null}
            readOnly={readOnly}
            inputRef={index === 0 ? takeFirst : undefined}
            onChange={(draft) => {
              setDrafts((current) => ({ ...current, [field.name]: draft }));
              // A message on show is checked again as the person fixes it.
              if (errors[field.name] !== undefined) setError(field.name, issueOf(field, draft));
            }}
            onBlur={() => {
              const draft = drafts[field.name] ?? null;
              const empty = answerValue(field, draft) === undefined;
              // An empty field is only called out once the person tried to submit.
              if (empty && !attempted) return;
              setError(field.name, issueOf(field, draft));
            }}
          />
        ))}
        {readOnly ? (
          item.response?.action === "decline" && (
            <p className={styles.hint}>You declined this request.</p>
          )
        ) : (
          <div className={styles.actions}>
            <Button
              ref={submitRef}
              type="submit"
              variant="primary"
              kbd="⌘⏎"
              aria-keyshortcuts="Meta+Enter"
              disabled={sent}
            >
              Submit
            </Button>
            <Button
              variant="default"
              disabled={sent}
              onClick={() => respond({ action: "decline" })}
            >
              Decline
            </Button>
            <Button
              ref={cancelRef}
              variant="ghost"
              kbd="esc"
              aria-keyshortcuts="Escape"
              disabled={sent}
              onClick={() => respond({ action: "cancel" })}
            >
              Cancel
            </Button>
          </div>
        )}
      </form>
    </DecisionFrame>
  );
}

function ElicitationPage({ item, env, autoFocus, readOnly }: FormProps) {
  const url = item.url ?? "";
  const host = hostOf(url);
  const [sent, setSent] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  useFocusOnAppear(openRef, autoFocus && !readOnly);
  const respond = (answer: ElicitationAnswer) => {
    if (sent || readOnly) return;
    setSent(true);
    env.respondElicitation(item.requestId, answer);
  };
  // Only when the person asks: the page is never fetched before.
  const open = () => {
    if (sent || readOnly) return;
    env.openLink(url);
    respond({ action: "accept" });
  };
  const heading = readOnly
    ? `${item.server} asked you to open a page`
    : `${item.server} asks you to open a page`;
  return (
    <DecisionFrame
      icon="globe"
      heading={heading}
      label={cardLabel(heading, item)}
      shortcuts={
        readOnly || sent
          ? null
          : { primary: open, secondary: open, escape: () => respond({ action: "cancel" }) }
      }
      readOnly={readOnly}
    >
      <AgentLine item={item} />
      {item.message.trim() !== "" && <p className={own.message}>{item.message}</p>}
      <dl className={own.page}>
        <dt>Site</dt>
        <dd className={own.host}>{host}</dd>
        <dt>Address</dt>
        <dd className={own.url}>{url}</dd>
      </dl>
      {host.includes("xn--") && (
        <p className={own.warning}>
          <Icon name="alert" size={14} />
          <span>
            This address uses letters from another alphabet, which can make one site look like
            another. Check it before you open it.
          </span>
        </p>
      )}
      {readOnly ? null : (
        <>
          <p className={styles.hint}>
            It opens in your browser. What you type there goes to the site, not through dawg.
          </p>
          <div className={styles.actions}>
            <Button
              ref={openRef}
              variant="primary"
              icon="external"
              kbd="⏎"
              aria-keyshortcuts="Enter Meta+Enter"
              disabled={sent}
              onClick={open}
            >
              Open page
            </Button>
            <Button
              variant="default"
              disabled={sent}
              onClick={() => respond({ action: "decline" })}
            >
              Decline
            </Button>
            <Button
              variant="ghost"
              kbd="esc"
              aria-keyshortcuts="Escape"
              disabled={sent}
              onClick={() => respond({ action: "cancel" })}
            >
              Cancel
            </Button>
          </div>
        </>
      )}
    </DecisionFrame>
  );
}

export interface ElicitationCardProps {
  item: ElicitationItem;
  shownAgain: boolean;
  autoFocus: boolean;
  env: TranscriptEnv;
}

export const ElicitationCard = memo(function ElicitationCard({
  item,
  shownAgain,
  autoFocus,
  env,
}: ElicitationCardProps) {
  const Body = item.mode === "url" ? ElicitationPage : ElicitationForm;
  if (item.state === "pending") {
    return <Body item={item} env={env} autoFocus={autoFocus} readOnly={false} />;
  }
  const action = item.state === "answered" ? item.response?.action : undefined;
  return (
    <div className={styles.answered}>
      <DecisionRecord
        icon={action === "accept" ? "check" : action === "decline" ? "close" : "clock"}
        text={
          item.agent
            ? `${elicitationRecord(item)} · ${agentTitle(item.agent)}`
            : elicitationRecord(item)
        }
        shown={shownAgain}
        onShowAgain={(shown) => env.showCardAgain(item.requestId, shown)}
      />
      {shownAgain && <Body item={item} env={env} autoFocus={false} readOnly />}
    </div>
  );
});
