import { run } from "../app/run.ts";
import { useSystemTheme } from "../app/useTheme.ts";
import { useActions, useAppStore } from "../state/store.ts";
import { SettingsView } from "./SettingsView.tsx";

/** Settings, connected to the store. */
export function SettingsContainer() {
  const page = useAppStore((state) => state.layout.settingsPage);
  const appearance = useAppStore((state) => state.settings.appearance);
  const toolCalls = useAppStore((state) => state.settings.toolCalls);
  const theme = useAppStore((state) => state.resolvedTheme);
  const system = useSystemTheme();
  const actions = useActions();

  return (
    <SettingsView
      page={page}
      appearance={appearance}
      system={system}
      theme={theme}
      toolCalls={toolCalls}
      onSelectPage={(next) => actions.setSettingsPage(next)}
      onSetAppearance={(next) => run(actions.setAppearance(next))}
      onSetToolCallDisplay={(next) => run(actions.setToolCallDisplay(next))}
      onBack={() => actions.setView("sessions")}
    />
  );
}
