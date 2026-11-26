import type { ReactNode } from "react";
import type {
  Appearance,
  NewSessionWorktree,
  ResolvedTheme,
  ToolCallDisplay,
} from "../../shared/bridge.ts";
import { ThemeSwitch } from "../app/ThemeSwitch.tsx";
import titleBar from "../app/TitleBar.module.css";
import { TitleBarFrame } from "../app/TitleBarFrame.tsx";
import type { SettingsPage } from "../state/types.ts";
import { Button } from "../ui/index.ts";
import { GeneralPage } from "./GeneralPage.tsx";
import styles from "./Settings.module.css";
import { ShortcutsPage } from "./ShortcutsPage.tsx";

const PAGES: readonly { id: SettingsPage; label: string; comingLine: string }[] = [
  { id: "general", label: "General", comingLine: "" },
  { id: "models", label: "Models", comingLine: "" },
  {
    id: "permissions",
    label: "Permissions",
    comingLine: "The default permission mode, and the allow, ask and deny rules for each scope.",
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    comingLine: "Every keyboard shortcut in dawg-code, in one list.",
  },
];

export interface SettingsViewProps {
  page: SettingsPage;
  appearance: Appearance;
  /** What macOS shows right now. */
  system: ResolvedTheme;
  /** What the window shows right now. */
  theme: ResolvedTheme;
  toolCalls: ToolCallDisplay;
  /** Settings → General → Notifications and New sessions. */
  notifications: boolean;
  dockBadge: boolean;
  newSessionWorktree: NewSessionWorktree;
  /** Settings → Models, connected to the store by the container. */
  modelsPage?: ReactNode;
  /** Settings → Permissions, connected to the bridge by the container. */
  permissionsPage?: ReactNode;
  /** One-line notices (a failed request), above the pages. */
  notices?: ReactNode;
  onSelectPage(page: SettingsPage): void;
  onSetAppearance(appearance: Appearance): void;
  onSetToolCallDisplay(value: ToolCallDisplay): void;
  onSetNotifications(on: boolean): void;
  onSetDockBadge(on: boolean): void;
  onSetNewSessionWorktree(value: NewSessionWorktree): void;
  onBack(): void;
}

/** Settings, shown in place of the sessions view: its own title bar, a page list and the page. */
export function SettingsView(props: SettingsViewProps) {
  const current = PAGES.find((page) => page.id === props.page) ?? PAGES[0];
  return (
    <div className={styles.window}>
      <TitleBarFrame>
        <span className={titleBar.title}>Settings</span>
        <span className={titleBar.grow} />
        <span className={titleBar.actions}>
          <ThemeSwitch theme={props.theme} onSetAppearance={props.onSetAppearance} />
          <Button variant="ghost" size="sm" onClick={props.onBack}>
            Back to sessions
          </Button>
        </span>
      </TitleBarFrame>
      {props.notices}
      <div className={styles.body}>
        <nav className={styles.nav} aria-label="Settings pages">
          {PAGES.map((page) => (
            <button
              key={page.id}
              type="button"
              className={styles.navItem}
              aria-current={page.id === props.page ? "page" : undefined}
              onClick={() => props.onSelectPage(page.id)}
            >
              {page.label}
            </button>
          ))}
        </nav>
        <main className={styles.content}>
          {props.page === "general" ? (
            <GeneralPage
              appearance={props.appearance}
              system={props.system}
              toolCalls={props.toolCalls}
              notifications={props.notifications}
              dockBadge={props.dockBadge}
              newSessionWorktree={props.newSessionWorktree}
              onSetAppearance={props.onSetAppearance}
              onSetToolCallDisplay={props.onSetToolCallDisplay}
              onSetNotifications={props.onSetNotifications}
              onSetDockBadge={props.onSetDockBadge}
              onSetNewSessionWorktree={props.onSetNewSessionWorktree}
            />
          ) : props.page === "models" && props.modelsPage ? (
            props.modelsPage
          ) : props.page === "permissions" && props.permissionsPage ? (
            props.permissionsPage
          ) : props.page === "shortcuts" ? (
            <ShortcutsPage />
          ) : (
            <>
              <h1 className={styles.h1}>{current?.label}</h1>
              <div className={styles.empty}>
                <p className={styles.emptyTitle}>Not in this build yet</p>
                <p className={styles.emptyText}>{current?.comingLine}</p>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
