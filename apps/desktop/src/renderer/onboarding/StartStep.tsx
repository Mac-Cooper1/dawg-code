import type { ReactNode } from "react";
import type { ModelsState } from "../../shared/bridge.ts";
import { formatMemory } from "../lib/format.ts";
import modelStyles from "../models/Models.module.css";
import {
  findCatalogEntry,
  findInstalled,
  modelName,
  serverName,
  serverOf,
} from "../state/models.ts";
import { Button, Icon, Spinner } from "../ui/index.ts";
import styles from "./FirstRun.module.css";

export interface StartStepProps {
  state: ModelsState;
  modelId: string;
  /** Why it could not start, as a sentence. */
  error: string | null;
  onRetry(): void;
  onChooseAnother(): void;
}

type StepState = "done" | "active" | "failed" | "waiting";

function Step(props: { state: StepState; text: string; detail?: string | null }) {
  const icon: ReactNode =
    props.state === "done" ? (
      <Icon name="check" size={14} strokeWidth={2} />
    ) : props.state === "active" ? (
      <Spinner size={12} />
    ) : props.state === "failed" ? (
      <Icon name="close" size={14} strokeWidth={2} />
    ) : (
      <span className={modelStyles.waiting} />
    );
  return (
    <li className={modelStyles.step} data-state={props.state}>
      <span className={modelStyles.stepIcon} aria-hidden="true">
        {icon}
      </span>
      <span className={modelStyles.grow}>{props.text}</span>
      {props.detail && <span className={modelStyles.meta}>{props.detail}</span>}
    </li>
  );
}

const STATE_WORDS: Record<StepState, string> = {
  done: "done",
  active: "in progress",
  failed: "failed",
  waiting: "not started",
};

/** Starting the chosen model: loading it into memory (or checking its server answers). */
export function StartStep(props: StartStepProps) {
  const { state, modelId, error } = props;
  const option = findInstalled(state, modelId);
  const entry = findCatalogEntry(state, modelId);
  const name = modelName(state, modelId);
  const shortName = option?.shortLabel ?? entry?.shortLabel ?? name;
  const server = option?.source === "server" ? serverOf(state, modelId) : undefined;
  const loading = error === null;

  const steps: { state: StepState; text: string; detail?: string | null }[] = server
    ? [
        { state: "done", text: `Found ${serverName(server)}`, detail: server.url },
        {
          state: loading ? "active" : "failed",
          text: `Checking ${serverName(server)} answers`,
        },
        { state: "waiting", text: "Ready for your first session" },
      ]
    : [
        {
          state: option ? "done" : loading ? "active" : "failed",
          text: option ? `${name} is on this Mac` : `Getting ${name} ready`,
          detail: option?.origin === "catalog" ? "checked against its SHA-256" : null,
        },
        {
          state: option ? (loading ? "active" : "failed") : "waiting",
          text: `Loading ${shortName} into memory`,
          detail: entry ? `about ${formatMemory(entry.memoryBytes)}` : null,
        },
        { state: "waiting", text: "Ready for your first session" },
      ];

  return (
    <>
      <div>
        <h1 className={`${styles.h1} ${styles.h1Step}`}>
          {loading ? "Starting the model" : `Could not start ${name}`}
        </h1>
        <p className={styles.lead}>
          {loading
            ? server
              ? "This takes a moment."
              : "This takes under a minute the first time."
            : "Try again, or choose another model."}
        </p>
      </div>
      <section className={styles.feature} aria-label="Starting">
        <ol className={modelStyles.steps}>
          {steps.map((step) => (
            <Step key={step.text} {...step} />
          ))}
        </ol>
        {/* For VoiceOver, which does not read the icons. */}
        <p className="vh" aria-live="polite">
          {steps.map((step) => `${step.text}: ${STATE_WORDS[step.state]}.`).join(" ")}
        </p>
        {error !== null && (
          <>
            <p className={styles.failure} role="alert">
              <Icon name="alert" size={14} className={styles.failureIcon} />
              {error}
            </p>
            <div className={styles.buttons}>
              <Button variant="primary" onClick={props.onRetry}>
                Try again
              </Button>
              <Button variant="ghost" onClick={props.onChooseAnother}>
                Choose another model
              </Button>
            </div>
          </>
        )}
      </section>
    </>
  );
}
