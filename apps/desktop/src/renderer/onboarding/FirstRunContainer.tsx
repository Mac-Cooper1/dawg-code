import type { ReactNode } from "react";
import { Notices } from "../app/Notices.tsx";
import { run } from "../app/run.ts";
import { findCatalogEntry, findInstalled } from "../state/models.ts";
import { useActions, useAppStore } from "../state/store.ts";
import { DownloadStep } from "./DownloadStep.tsx";
import { FirstRun } from "./FirstRun.tsx";
import { StartStep } from "./StartStep.tsx";
import { Welcome } from "./Welcome.tsx";

/** First run, connected to the store. Renders nothing once it is over. */
export function FirstRunContainer() {
  const onboarding = useAppStore((state) => state.onboarding);
  const modelsState = useAppStore((state) => state.modelsState);
  const theme = useAppStore((state) => state.resolvedTheme);
  const notices = useAppStore((state) => state.notices);
  const actions = useActions();
  if (!onboarding || !modelsState) return null;

  let page: ReactNode;
  switch (onboarding.step) {
    case "welcome":
      page = (
        <Welcome
          state={modelsState}
          onSetUp={(modelId, options) => run(actions.setUpModel(modelId, options))}
          onAddModelFile={() => actions.addModelFile()}
          onConnectServer={(input) => actions.connectServer(input)}
          onOpenLink={(url) => run(actions.openExternal(url))}
        />
      );
      break;
    case "download":
      page = (
        <DownloadStep
          state={modelsState}
          modelId={onboarding.modelId}
          error={onboarding.error}
          onPause={() => run(actions.pauseDownload(onboarding.modelId))}
          onResume={() => run(actions.setUpModel(onboarding.modelId))}
          onCancel={() => run(actions.cancelDownload(onboarding.modelId))}
          onChooseAnother={() => actions.showWelcome()}
        />
      );
      break;
    case "start":
      page = (
        <StartStep
          state={modelsState}
          modelId={onboarding.modelId}
          error={onboarding.error}
          onRetry={() => {
            // Another app's copy that could not be adopted is tried again the same way.
            const { modelId } = onboarding;
            const adopt =
              !findInstalled(modelsState, modelId) &&
              (findCatalogEntry(modelsState, modelId)?.foundIn ?? null) !== null;
            run(actions.setUpModel(modelId, adopt ? { useExisting: true } : undefined));
          }}
          onChooseAnother={() => actions.showWelcome()}
        />
      );
      break;
  }

  return (
    <FirstRun
      step={onboarding.step}
      theme={theme}
      onSetAppearance={(appearance) => run(actions.setAppearance(appearance))}
      notices={<Notices notices={notices} onDismiss={(id) => actions.dismissNotice(id)} />}
    >
      {page}
    </FirstRun>
  );
}
