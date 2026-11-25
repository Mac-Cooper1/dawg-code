import type { SessionId } from "@dawg/protocol";
import { run } from "../app/run.ts";
import { selectComposer } from "../state/selectors.ts";
import { useActions, useAppStore } from "../state/store.ts";
import { Composer } from "./Composer.tsx";

/** The composer for one session, connected to the store. */
export function ComposerContainer(props: { sessionId: SessionId }) {
  const { sessionId } = props;
  const view = useAppStore((state) => selectComposer(state, sessionId));
  const models = useAppStore((state) => state.models);
  const loadedModelId = useAppStore((state) => state.modelStatus?.modelId ?? null);
  const phase = useAppStore((state) => state.connection.phase);
  const actions = useActions();
  if (!view) return null;

  return (
    <Composer
      view={view}
      models={models}
      loadedModelId={loadedModelId}
      canSend={phase === "ready"}
      disabled={phase === "failed"}
      onDraftChange={(text) => actions.setDraft(sessionId, text)}
      onSubmit={(text) => run(actions.submit(sessionId, text))}
      onInterrupt={() => run(actions.interrupt(sessionId))}
      onSetMode={(mode) => run(actions.setMode(sessionId, mode))}
      onCycleMode={() => run(actions.cycleMode(sessionId))}
      onSetModel={(id) => run(actions.setModel(sessionId, id))}
      onSetEffort={(effort) => run(actions.setEffort(sessionId, effort))}
      onCompact={() => run(actions.compact(sessionId))}
      onSendQueuedNow={(id) => run(actions.sendQueuedNow(sessionId, id))}
      onRemoveQueued={(id) => actions.removeQueued(sessionId, id)}
      onManageModels={() => {
        actions.setSettingsPage("models");
        actions.setView("settings");
      }}
    />
  );
}
