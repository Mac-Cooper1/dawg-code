import { type ReactNode, useEffect, useRef } from "react";
import type { ResolvedTheme } from "../../shared/bridge.ts";
import { ThemeSwitch } from "../app/ThemeSwitch.tsx";
import titleBar from "../app/TitleBar.module.css";
import { TitleBarFrame } from "../app/TitleBarFrame.tsx";
import logoUrl from "../assets/logo.png";
import type { OnboardingState } from "../state/types.ts";
import { focusIsLost } from "../ui/focus.ts";
import { Icon } from "../ui/index.ts";
import styles from "./FirstRun.module.css";

const STEPS = [
  { step: "welcome", label: "Choose a model" },
  { step: "download", label: "Download" },
  { step: "start", label: "Start" },
] as const;

/** "1 Choose a model", "2 Download", "3 Start": done ones ticked, the current one raised. */
function StepChips(props: { step: OnboardingState["step"] }) {
  const current = STEPS.findIndex((item) => item.step === props.step);
  return (
    <ol className={styles.stepChips} aria-label="Setup steps">
      {STEPS.map((item, index) => {
        const state = index < current ? "done" : index === current ? "current" : "todo";
        return (
          <li
            key={item.step}
            className={styles.stepChip}
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
          >
            {state === "done" ? (
              <Icon name="check" size={12} strokeWidth={2.2} />
            ) : (
              <span className={styles.stepNumber}>{index + 1}</span>
            )}
            {item.label}
            {state === "done" && <span className="vh">, done</span>}
          </li>
        );
      })}
    </ol>
  );
}

export interface FirstRunProps {
  step: OnboardingState["step"];
  theme: ResolvedTheme;
  onSetAppearance(appearance: ResolvedTheme): void;
  /** One-line notices (a failed request), above the page. */
  notices?: ReactNode;
  /** The step's page. */
  children: ReactNode;
}

/**
 * The first-run window: the steps in the title bar, the app's icon and name, then the step.
 * Shown in place of the sessions view until the chosen model runs.
 */
export function FirstRun(props: FirstRunProps) {
  const main = useRef<HTMLElement>(null);
  const shownStep = useRef(props.step);
  // A new step replaces the button that moved to it, so focus would fall to the page: it goes to
  // the step's heading instead, which VoiceOver reads, and Tab carries on from there.
  useEffect(() => {
    if (shownStep.current === props.step) return;
    shownStep.current = props.step;
    if (!focusIsLost()) return;
    const heading = main.current?.querySelector<HTMLElement>("h1");
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [props.step]);

  return (
    <div className={styles.window}>
      <TitleBarFrame>
        <span className={titleBar.grow} />
        <StepChips step={props.step} />
        <span className={titleBar.grow} />
        <span className={titleBar.actions}>
          <ThemeSwitch theme={props.theme} onSetAppearance={props.onSetAppearance} />
        </span>
      </TitleBarFrame>
      {props.notices}
      <main ref={main} className={styles.scroll}>
        <div className={styles.column}>
          <div className={styles.brand}>
            <img
              className={`${styles.logo} ${props.step === "welcome" ? "" : styles.logoSmall}`}
              src={logoUrl}
              alt=""
              width={80}
              height={80}
              draggable={false}
            />
            <span className={styles.word}>dawg-code</span>
          </div>
          {props.children}
        </div>
      </main>
    </div>
  );
}
