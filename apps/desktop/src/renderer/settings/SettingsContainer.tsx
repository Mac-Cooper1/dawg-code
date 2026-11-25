import { Notices } from "../app/Notices.tsx";
import { run } from "../app/run.ts";
import { useSystemTheme } from "../app/useTheme.ts";
import { useActions, useAppStore } from "../state/store.ts";
import { ModelsPage } from "./ModelsPage.tsx";
import { SettingsView } from "./SettingsView.tsx";

/** Settings → Models, connected to the store: it follows every models state, progress included. */
function ModelsPageContainer() {
  const state = useAppStore((store) => store.modelsState);
  const actions = useActions();
  return <ModelsPage state={state} actions={actions} />;
}

function SettingsNotices() {
  const notices = useAppStore((state) => state.notices);
  const actions = useActions();
  return <Notices notices={notices} onDismiss={(id) => actions.dismissNotice(id)} />;
}

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
      modelsPage={<ModelsPageContainer />}
      notices={<SettingsNotices />}
      onSelectPage={(next) => actions.setSettingsPage(next)}
      onSetAppearance={(next) => run(actions.setAppearance(next))}
      onSetToolCallDisplay={(next) => run(actions.setToolCallDisplay(next))}
      onBack={() => actions.setView("sessions")}
    />
  );
}
