/**
 * Hooks in the transcript. A hook that ran is one compact line ("PreToolUse hook blocked Bash:
 * rm -rf is not allowed") that opens to where it comes from, what it runs, its exit code and its
 * timing. A plain successful run stays quiet; a block or a failure stands out. Hooks held back for
 * the person's consent are one quiet line with a way to review them.
 */
import { memo, useId } from "react";
import { shortenPath } from "../lib/format.ts";
import {
  handlerTypeLabel,
  hookDuration,
  hookLine,
  hookTone,
  skippedLine,
  sourceLabel,
} from "../lib/hooks.ts";
import type { HookItem, HookSkippedItem } from "../state/types.ts";
import { Button, Icon, type IconName } from "../ui/index.ts";
import type { TranscriptEnv } from "./env.ts";
import styles from "./HookView.module.css";

const TONE_CLASS = {
  quiet: undefined,
  blocked: styles.blocked,
  error: styles.error,
} as const;

const TONE_ICON: Record<keyof typeof TONE_CLASS, IconName> = {
  quiet: "terminal",
  blocked: "shield",
  error: "alert",
};

/** What the row naming a hook's target is called, by handler type. */
const TARGET_LABEL: Readonly<Record<string, string>> = {
  command: "Command",
  http: "Address",
  prompt: "Prompt",
  agent: "Prompt",
  mcp_tool: "Server and tool",
};

function clockTime(time: number): string {
  return new Date(time).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export const HookView = memo(function HookView({
  item,
  open,
  env,
}: {
  item: HookItem;
  open: boolean;
  env: TranscriptEnv;
}) {
  const bodyId = useId();
  const tone = hookTone(item);
  const line = hookLine(item);
  const { hook } = item;
  const classes = [styles.hook, TONE_CLASS[tone]].filter(Boolean).join(" ");
  return (
    <div className={classes} data-outcome={item.outcome}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        title={line}
        onClick={() => env.setItemOpen(item.id, !open)}
      >
        <Icon
          name="chevron-right"
          size={12}
          className={open ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron}
        />
        <Icon name={TONE_ICON[tone]} size={14} className={styles.icon} />
        <span className={styles.line}>{line}</span>
      </button>
      {open && (
        <dl id={bodyId} className={styles.details}>
          <dt>Source</dt>
          <dd>
            <code className={styles.code}>{shortenPath(hook.source.path, env.homeDir)}</code>
            <span className={styles.muted}> · {sourceLabel(hook.source)}</span>
          </dd>
          {hook.matcher !== null && hook.matcher !== "" && (
            <>
              <dt>Matcher</dt>
              <dd>
                <code className={styles.code}>{hook.matcher}</code>
              </dd>
            </>
          )}
          {hook.type !== "command" && (
            <>
              <dt>Type</dt>
              <dd>{handlerTypeLabel(hook.type)} hook</dd>
            </>
          )}
          <dt>{TARGET_LABEL[hook.type] ?? "Runs"}</dt>
          <dd>
            <code className={`${styles.code} ${styles.command}`}>{hook.command}</code>
          </dd>
          {hook.type === "command" ? (
            <>
              <dt>Exit code</dt>
              <dd>
                {item.exitCode !== null
                  ? item.exitCode
                  : item.outcome === "timeout"
                    ? "None: it was stopped at its time limit"
                    : "None"}
              </dd>
            </>
          ) : (
            item.outcome === "timeout" && (
              <>
                <dt>Answer</dt>
                <dd>None: it was stopped at its time limit</dd>
              </>
            )
          )}
          <dt>Ran</dt>
          <dd>
            {clockTime(item.time - item.durationMs)} · took {hookDuration(item.durationMs)}
          </dd>
          {item.message !== null && item.message.trim() !== "" && (
            <>
              <dt>Said</dt>
              <dd className={styles.message}>{item.message}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
});

export const HookSkippedView = memo(function HookSkippedView({
  item,
  env,
}: {
  item: HookSkippedItem;
  env: TranscriptEnv;
}) {
  const { projectDir } = item;
  const review = env.reviewProjectCode;
  return (
    <div className={styles.skipped}>
      <Icon name="shield" size={14} className={styles.icon} />
      <span className={styles.skippedText}>{skippedLine(item.sources)}</span>
      {projectDir !== null && review !== null && (
        <Button size="sm" variant="ghost" onClick={() => review(projectDir)}>
          Review
        </Button>
      )}
    </div>
  );
});
