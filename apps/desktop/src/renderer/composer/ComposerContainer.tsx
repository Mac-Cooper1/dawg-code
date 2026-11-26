import type { SessionId } from "@dawg/protocol";
import { useCallback } from "react";
import { run } from "../app/run.ts";
import { getBridge } from "../bridge/index.ts";
import { selectComposer } from "../state/selectors.ts";
import { useActions, useAppStore } from "../state/store.ts";
import type { ImageAttachment } from "../state/types.ts";
import { Composer } from "./Composer.tsx";

const NO_IMAGES: readonly ImageAttachment[] = Object.freeze([]);
const NO_PATHS: readonly string[] = Object.freeze([]);

/** How many files the `@` menu lists. */
const MENU_LIMIT = 50;

/** The composer for one session, connected to the store. */
export function ComposerContainer(props: { sessionId: SessionId }) {
  const { sessionId } = props;
  const view = useAppStore((state) => selectComposer(state, sessionId));
  const models = useAppStore((state) => state.models);
  const loadedModelId = useAppStore((state) => state.modelStatus?.modelId ?? null);
  const phase = useAppStore((state) => state.connection.phase);
  const attachments = useAppStore((state) => state.ui.attachments[sessionId] ?? NO_IMAGES);
  const mentionPaths = useAppStore((state) => state.ui.mentionPaths[sessionId] ?? NO_PATHS);
  const actions = useActions();
  const findFiles = useCallback(
    async (query: string) => {
      // Main answers only for sessions a window tracks; tracking again is free.
      await actions.trackSession(sessionId);
      return getBridge().workspace.findFiles({ sessionId, query, limit: MENU_LIMIT });
    },
    [actions, sessionId],
  );
  if (!view) return null;

  return (
    <Composer
      view={view}
      models={models}
      loadedModelId={loadedModelId}
      canSend={phase === "ready"}
      disabled={phase === "failed"}
      attachments={attachments}
      mentionPaths={mentionPaths}
      onDraftChange={(text) => actions.setDraft(sessionId, text)}
      onSubmit={(text, mentions) =>
        run(mentions ? actions.submit(sessionId, text, mentions) : actions.submit(sessionId, text))
      }
      onFindFiles={findFiles}
      onAddAttachments={(images) => actions.addAttachments(sessionId, images)}
      onRemoveAttachment={(id) => actions.removeAttachment(sessionId, id)}
      onRememberMention={(path) => actions.rememberMention(sessionId, path)}
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
