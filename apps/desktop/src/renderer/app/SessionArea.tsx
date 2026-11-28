import type { SessionId } from "@dawg/protocol";
import { useEffect, useMemo } from "react";
import { getBridge } from "../bridge/index.ts";
import { ComposerContainer } from "../composer/ComposerContainer.tsx";
import { selectSubagentPanel, selectTranscript } from "../state/selectors.ts";
import { useActions, useAppStore, useAppStoreApi } from "../state/store.ts";
import type { ForkMarkerView } from "../transcript/ForkMarker.tsx";
import { Transcript } from "../transcript/Transcript.tsx";
import { focusIsLost, focusMessageField } from "../ui/focus.ts";
import styles from "./App.module.css";
import { run } from "./run.ts";
import { focusAgentCard, SubagentPanel } from "./SubagentPanel.tsx";

/** A session made this recently, with nothing in it, counts as new when it is shown. */
const NEW_SESSION_MS = 60_000;

/** Opens a link from model output in the system browser (the transcript has shown the URL). */
function openExternal(url: string): void {
  run(Promise.resolve().then(() => getBridge().shell.openExternal(url)));
}

/**
 * The selected session: its transcript above, the composer below; or, while one is open, a
 * subagent's transcript in their place.
 */
export function SessionArea(props: { sessionId: SessionId }) {
  const { sessionId } = props;
  const view = useAppStore((state) => selectTranscript(state, sessionId));
  const homeDir = useAppStore((state) => state.homeDir);
  // With text in the composer, a new card must not take focus from it.
  const draftEmpty = useAppStore((state) => (state.ui.drafts[sessionId] ?? "") === "");
  const subagent = useAppStore((state) => selectSubagentPanel(state, sessionId));
  const actions = useActions();
  // A fork (a rewind's or a plain one) shows where its own conversation starts.
  const forkedFrom = useAppStore((state) => state.sessions[sessionId]?.summary.forkedFrom ?? null);
  const original = useAppStore((state) =>
    forkedFrom === null ? undefined : state.sessions[forkedFrom.sessionId],
  );
  const originalTitle = original?.summary.title ?? null;
  const originalShown = original !== undefined && !original.summary.archived;
  const fork = useMemo<ForkMarkerView | null>(
    () =>
      forkedFrom === null
        ? null
        : {
            originalId: forkedFrom.sessionId,
            originalTitle,
            originalShown,
            point: forkedFrom.point,
          },
    [forkedFrom, originalTitle, originalShown],
  );

  // Showing a session: a new one (made a moment ago, nothing sent yet) puts focus in its message
  // field, ready for the first message; any other takes focus only when it fell to the page (at
  // launch, or the session that had it was deleted). A decision card that took focus keeps it.
  const store = useAppStoreApi();
  useEffect(() => {
    const state = store.getState();
    const summary = state.sessions[sessionId]?.summary;
    const isNew =
      summary !== undefined &&
      summary.title === null &&
      Date.now() - summary.createdAt < NEW_SESSION_MS &&
      (state.transcripts[sessionId]?.length ?? 0) === 0;
    const timer = setTimeout(() => {
      if (document.activeElement?.closest("main")) return;
      if (isNew || focusIsLost()) focusMessageField();
    }, 0);
    return () => clearTimeout(timer);
  }, [store, sessionId]);

  if (subagent) {
    const { agentId } = subagent.agent;
    return (
      <SubagentPanel
        key={agentId}
        view={subagent}
        homeDir={homeDir}
        onClose={() => {
          actions.closeSubagent();
          focusAgentCard(agentId);
        }}
        onRetry={() => actions.openSubagent(sessionId, agentId)}
        onSetItemOpen={(itemId, open) =>
          actions.setItemOpen(subagent.agent.sessionId, itemId, open)
        }
        onOpenLink={openExternal}
      />
    );
  }

  return (
    <>
      <div className={styles.transcript}>
        {view ? (
          <Transcript
            sessionId={sessionId}
            view={view}
            homeDir={homeDir}
            autoFocusPendingCard={draftEmpty}
            onSetItemOpen={(itemId, open) => actions.setItemOpen(sessionId, itemId, open)}
            onShowCardAgain={(requestId, shown) =>
              actions.setShownAgain(sessionId, requestId, shown)
            }
            onRespondPermission={(requestId, response) =>
              run(actions.respondPermission(sessionId, requestId, response))
            }
            onRespondQuestion={(requestId, response) =>
              run(actions.respondQuestion(sessionId, requestId, response))
            }
            onRespondPlan={(requestId, response) =>
              run(actions.respondPlan(sessionId, requestId, response))
            }
            onRespondElicitation={(requestId, answer) =>
              run(actions.respondElicitation(sessionId, requestId, answer))
            }
            onOpenLink={openExternal}
            onReviewProjectCode={(projectDir) => actions.reviewProjectCode(projectDir)}
            onOpenSubagent={(agentId) => actions.openSubagent(sessionId, agentId)}
            fork={fork}
            onOpenOriginal={() => {
              if (fork !== null) actions.selectSession(fork.originalId);
            }}
          />
        ) : (
          <p className={styles.loading}>Loading the session…</p>
        )}
      </div>
      <ComposerContainer sessionId={sessionId} />
    </>
  );
}
