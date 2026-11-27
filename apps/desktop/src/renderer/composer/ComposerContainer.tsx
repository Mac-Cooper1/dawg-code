import type { CommandInfo, SessionId } from "@dawg/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { run } from "../app/run.ts";
import { getBridge } from "../bridge/index.ts";
import { selectComposer } from "../state/selectors.ts";
import { useActions, useAppStore } from "../state/store.ts";
import type { ImageAttachment, McpOffer } from "../state/types.ts";
import { Composer } from "./Composer.tsx";
import { resourceMatches } from "./mcpResources.ts";

const NO_IMAGES: readonly ImageAttachment[] = Object.freeze([]);
const NO_PATHS: readonly string[] = Object.freeze([]);

const NO_PROMPTS: readonly CommandInfo[] = Object.freeze([]);
/** How long an answer of `mcp.session` is used before it is asked again. */
const OFFER_TTL_MS = 3_000;

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
  // What the session's MCP servers offer: resources for `@`, prompts for `/` (servers connect
  // after the session opened, so this is asked again now and then rather than kept).
  const offer = useRef<{ at: number; offer: Promise<McpOffer> } | null>(null);
  const mcpOffer = useCallback(() => {
    const now = Date.now();
    if (offer.current === null || now - offer.current.at > OFFER_TTL_MS) {
      offer.current = { at: now, offer: actions.mcpOffer(sessionId) };
    }
    return offer.current.offer;
  }, [actions, sessionId]);
  const findFiles = useCallback(
    async (query: string) => {
      // Main answers only for sessions a window tracks; tracking again is free.
      await actions.trackSession(sessionId);
      const [files, mcp] = await Promise.all([
        getBridge().workspace.findFiles({ sessionId, query, limit: MENU_LIMIT }),
        mcpOffer(),
      ]);
      const resources = resourceMatches(mcp.resources, query);
      return resources.length === 0
        ? files
        : { ...files, matches: [...files.matches, ...resources] };
    },
    [actions, mcpOffer, sessionId],
  );
  const [prompts, setPrompts] = useState<readonly CommandInfo[]>(NO_PROMPTS);
  const typingCommand = view?.draft.startsWith("/") ?? false;
  useEffect(() => {
    if (!typingCommand) return;
    let live = true;
    void mcpOffer().then((mcp) => {
      if (live) setPrompts(mcp.prompts.length === 0 ? NO_PROMPTS : mcp.prompts);
    });
    return () => {
      live = false;
    };
  }, [mcpOffer, typingCommand]);
  const shown = useMemo(() => {
    if (!view || prompts.length === 0) return view;
    const names = new Set(view.commands.map((c) => c.name));
    const extra = prompts.filter((p) => !names.has(p.name));
    return extra.length === 0 ? view : { ...view, commands: [...view.commands, ...extra] };
  }, [view, prompts]);
  if (!shown) return null;

  return (
    <Composer
      view={shown}
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
      onRewind={() => run(actions.openRewind(sessionId))}
    />
  );
}
