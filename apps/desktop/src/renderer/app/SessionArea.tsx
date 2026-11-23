import type { SessionId } from "@dawg/protocol";
import { getBridge } from "../bridge/index.ts";
import { ComposerContainer } from "../composer/ComposerContainer.tsx";
import { selectTranscript } from "../state/selectors.ts";
import { useActions, useAppStore } from "../state/store.ts";
import { Transcript } from "../transcript/Transcript.tsx";
import styles from "./App.module.css";
import { run } from "./run.ts";

/** Opens a link from model output in the system browser (the transcript has shown the URL). */
function openExternal(url: string): void {
  run(Promise.resolve().then(() => getBridge().shell.openExternal(url)));
}

/** The selected session: its transcript above, the composer below. */
export function SessionArea(props: { sessionId: SessionId }) {
  const { sessionId } = props;
  const view = useAppStore((state) => selectTranscript(state, sessionId));
  const homeDir = useAppStore((state) => state.homeDir);
  // With text in the composer, a new card must not take focus from it.
  const draftEmpty = useAppStore((state) => (state.ui.drafts[sessionId] ?? "") === "");
  const actions = useActions();

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
            onOpenLink={openExternal}
          />
        ) : (
          <p className={styles.loading}>Loading the session…</p>
        )}
      </div>
      <ComposerContainer sessionId={sessionId} />
    </>
  );
}
