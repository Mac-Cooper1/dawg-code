import { RadioGroup, Switch } from "radix-ui";
import { useId } from "react";
import type {
  Appearance,
  NewSessionWorktree,
  ResolvedTheme,
  ToolCallDisplay,
} from "../../shared/bridge.ts";
import { AppearancePicker } from "./AppearancePicker.tsx";
import page from "./GeneralPage.module.css";
import styles from "./Settings.module.css";
import { ToolCallOptions } from "./ToolCallOptions.tsx";

export interface GeneralPageProps {
  appearance: Appearance;
  system: ResolvedTheme;
  toolCalls: ToolCallDisplay;
  /** A macOS notification when a session needs the person, finishes or fails. */
  notifications: boolean;
  /** The Dock icon counts the sessions that need the person. */
  dockBadge: boolean;
  newSessionWorktree: NewSessionWorktree;
  onSetAppearance(appearance: Appearance): void;
  onSetToolCallDisplay(value: ToolCallDisplay): void;
  onSetNotifications(on: boolean): void;
  onSetDockBadge(on: boolean): void;
  onSetNewSessionWorktree(value: NewSessionWorktree): void;
}

/**
 * Settings → General: appearance, how tool calls show in the transcript, notifications and the
 * Dock badge, and where new sessions run.
 */
export function GeneralPage(props: GeneralPageProps) {
  return (
    <>
      <h1 className={styles.h1}>General</h1>
      <p className={styles.lead}>
        How dawg looks, how it gets your attention, and where new sessions run.
      </p>

      <h2 className={styles.h2}>Appearance</h2>
      <AppearancePicker
        value={props.appearance}
        system={props.system}
        onChange={props.onSetAppearance}
      />
      <p className={styles.note}>
        The moon and sun button in each window’s title bar switches between Dark and Light and saves
        the choice here.
      </p>

      <h2 className={styles.h2}>Tool calls in the transcript</h2>
      <ToolCallOptions value={props.toolCalls} onChange={props.onSetToolCallDisplay} />

      <h2 className={styles.h2}>Notifications</h2>
      <div className={page.switches}>
        <SettingSwitch
          title="Notify me when a session needs me or finishes"
          description="Only while dawg is in the background. Click one to open its session."
          checked={props.notifications}
          onChange={props.onSetNotifications}
        />
        <SettingSwitch
          title="Show a count on the Dock icon"
          description="How many sessions are waiting on you."
          checked={props.dockBadge}
          onChange={props.onSetDockBadge}
        />
      </div>
      <p className={styles.note}>Sounds and banners follow System Settings → Notifications.</p>

      <h2 className={styles.h2}>New sessions</h2>
      <NewSessionOptions
        value={props.newSessionWorktree}
        onChange={props.onSetNewSessionWorktree}
      />
      <p className={styles.note}>
        A folder that is not a git repository has no worktrees, so sessions run in the folder.
      </p>
    </>
  );
}

/** One on/off setting: its title and a line saying what it does, and the switch. */
function SettingSwitch(props: {
  title: string;
  description: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  const switchId = useId();
  const titleId = useId();
  const descriptionId = useId();
  return (
    <div className={page.switchRow}>
      {/* The whole text toggles the switch; its name stays the title alone. */}
      <label htmlFor={switchId} className={page.switchText}>
        <span id={titleId} className={page.switchTitle}>
          {props.title}
        </span>
        <span id={descriptionId} className={page.switchDescription}>
          {props.description}
        </span>
      </label>
      <Switch.Root
        id={switchId}
        className={page.switch}
        checked={props.checked}
        onCheckedChange={props.onChange}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <Switch.Thumb className={page.thumb} />
      </Switch.Root>
    </div>
  );
}

const NEW_SESSION_OPTIONS: readonly {
  value: NewSessionWorktree;
  title: string;
  description: string;
}[] = [
  {
    value: "ask",
    title: "Ask each time",
    description: "Choose the project folder or a new worktree when you start a session",
  },
  {
    value: "folder",
    title: "In the project folder",
    description: "Start at once, in your own checkout",
  },
  {
    value: "worktree",
    title: "In a new worktree",
    description:
      "Start at once on a new branch from the current one, apart from your work and other sessions",
  },
];

function NewSessionOption(props: (typeof NEW_SESSION_OPTIONS)[number]) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <RadioGroup.Item
      value={props.value}
      className={styles.option}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <span className={styles.radio} aria-hidden="true" />
      <span className={styles.optionText}>
        <span id={titleId} className={styles.optionTitle}>
          {props.title}
        </span>
        <span id={descriptionId} className={styles.optionDescription}>
          {props.description}
        </span>
      </span>
    </RadioGroup.Item>
  );
}

/** Settings → General → New sessions: where a new session in a git project runs. */
function NewSessionOptions(props: {
  value: NewSessionWorktree;
  onChange(value: NewSessionWorktree): void;
}) {
  return (
    <RadioGroup.Root
      className={styles.options}
      value={props.value}
      aria-label="New sessions"
      onValueChange={(value) => {
        const option = NEW_SESSION_OPTIONS.find((candidate) => candidate.value === value);
        if (option) props.onChange(option.value);
      }}
    >
      {NEW_SESSION_OPTIONS.map((option) => (
        <NewSessionOption key={option.value} {...option} />
      ))}
    </RadioGroup.Root>
  );
}
