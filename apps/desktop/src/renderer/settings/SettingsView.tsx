import type { Appearance, ResolvedTheme, ToolCallDisplay } from "../../shared/bridge.ts";
import { ThemeSwitch } from "../app/ThemeSwitch.tsx";
import titleBar from "../app/TitleBar.module.css";
import { TitleBarFrame } from "../app/TitleBarFrame.tsx";
import type { SettingsPage } from "../state/types.ts";
import { Button } from "../ui/index.ts";
import { GeneralPage } from "./GeneralPage.tsx";
import styles from "./Settings.module.css";

const PAGES: readonly { id: SettingsPage; label: string; comingLine: string }[] = [
  { id: "general", label: "General", comingLine: "" },
  {
    id: "models",
    label: "Models",
    comingLine: "The models on this Mac, the ones you can download, and the servers dawg can use.",
  },
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
  onSelectPage(page: SettingsPage): void;
  onSetAppearance(appearance: Appearance): void;
  onSetToolCallDisplay(value: ToolCallDisplay): void;
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
              onSetAppearance={props.onSetAppearance}
              onSetToolCallDisplay={props.onSetToolCallDisplay}
            />
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
