/**
 * "dawg is asking": the model's questions, each with its options as a radio group (or checkboxes
 * for several answers) and a free-text answer. Number keys pick options while focus is in the
 * card.
 */
import type { Question, QuestionAnswer, QuestionResponse } from "@dawg/protocol";
import { memo, type RefObject, useId, useRef, useState } from "react";
import { TextWithCode } from "../markdown/index.ts";
import type { QuestionItem } from "../state/types.ts";
import type { TranscriptEnv } from "../transcript/env.ts";
import { Button, Icon, Kbd } from "../ui/index.ts";
import styles from "./DecisionCard.module.css";
import { DecisionFrame, DecisionRecord, useFocusOnAppear } from "./DecisionFrame.tsx";
import { isTextField } from "./keys.ts";
import { questionRecord } from "./records.ts";

interface Draft {
  selected: string[];
  text: string;
}

function emptyDrafts(questions: readonly Question[]): Draft[] {
  return questions.map(() => ({ selected: [], text: "" }));
}

/** Drafts filled from an answer, to show an answered card again. */
function draftsFromAnswers(
  questions: readonly Question[],
  answers: readonly QuestionAnswer[],
): Draft[] {
  return questions.map((question) => {
    const answer = answers.find((candidate) => candidate.question === question.question);
    return { selected: answer ? [...answer.selected] : [], text: answer?.text ?? "" };
  });
}

function QuestionFields({
  question,
  index,
  draft,
  readOnly,
  showHeader,
  onToggle,
  onText,
  firstOptionRef,
}: {
  question: Question;
  index: number;
  draft: Draft;
  readOnly: boolean;
  /** Show the question's header chip next to it (when the card asks several questions). */
  showHeader: boolean;
  onToggle(label: string): void;
  onText(text: string): void;
  firstOptionRef?: RefObject<HTMLInputElement | null> | undefined;
}) {
  const textId = useId();
  const groupName = useId();
  const type = question.multiSelect ? "checkbox" : "radio";
  const options = question.options.map((option, optionIndex) => {
    const checked = draft.selected.includes(option.label);
    const number = optionIndex + 1;
    return (
      <label key={option.label} className={styles.option}>
        <input
          ref={optionIndex === 0 ? firstOptionRef : undefined}
          className={styles.nativeInput}
          type={type}
          name={groupName}
          value={option.label}
          checked={checked}
          disabled={readOnly}
          aria-labelledby={`${groupName}-${optionIndex}-label`}
          aria-describedby={
            option.description ? `${groupName}-${optionIndex}-description` : undefined
          }
          aria-keyshortcuts={number <= 9 ? String(number) : undefined}
          onChange={() => onToggle(option.label)}
        />
        <span
          className={question.multiSelect ? `${styles.mark} ${styles.markSquare}` : styles.mark}
          aria-hidden="true"
        >
          {question.multiSelect && checked && <Icon name="check" size={12} strokeWidth={2.2} />}
        </span>
        <span className={styles.optionText}>
          <span id={`${groupName}-${optionIndex}-label`} className={styles.optionLabel}>
            <TextWithCode text={option.label} />
          </span>
          {option.description && (
            <span
              id={`${groupName}-${optionIndex}-description`}
              className={styles.optionDescription}
            >
              <TextWithCode text={option.description} />
            </span>
          )}
        </span>
        {number <= 9 && (
          <span aria-hidden="true">
            <Kbd>{number}</Kbd>
          </span>
        )}
      </label>
    );
  });
  return (
    <div className={styles.question} data-question-index={index}>
      <p id={textId} className={styles.questionText}>
        <TextWithCode text={question.question} />
        {showHeader && question.header && (
          <span className={styles.headerChip}>
            <TextWithCode text={question.header} />
          </span>
        )}
      </p>
      {question.options.length > 0 &&
        (question.multiSelect ? (
          <fieldset className={`${styles.options} ${styles.fieldset}`} aria-labelledby={textId}>
            {options}
          </fieldset>
        ) : (
          <div className={styles.options} role="radiogroup" aria-labelledby={textId}>
            {options}
          </div>
        ))}
      <input
        className={styles.input}
        type="text"
        placeholder="Or type your own answer"
        aria-label={showHeader ? `Your own answer to: ${question.question}` : "Your own answer"}
        value={draft.text}
        readOnly={readOnly}
        onChange={(event) => onText(event.target.value)}
      />
    </div>
  );
}

function QuestionForm({
  item,
  env,
  autoFocus,
  readOnly,
}: {
  item: QuestionItem;
  env: TranscriptEnv;
  autoFocus: boolean;
  readOnly: boolean;
}) {
  const { questions } = item;
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    readOnly && item.response?.outcome === "answered"
      ? draftsFromAnswers(questions, item.response.answers)
      : emptyDrafts(questions),
  );
  const [sent, setSent] = useState(false);
  const [missing, setMissing] = useState(false);
  const firstOptionRef = useRef<HTMLInputElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const hasOptions = (questions[0]?.options.length ?? 0) > 0;
  useFocusOnAppear(hasOptions ? firstOptionRef : sendRef, autoFocus && !readOnly);

  const update = (index: number, change: (draft: Draft) => Draft) => {
    setMissing(false);
    setDrafts((current) => current.map((draft, i) => (i === index ? change(draft) : draft)));
  };
  const toggle = (index: number, label: string) => {
    const question = questions[index];
    if (!question || readOnly) return;
    update(index, (draft) => {
      if (!question.multiSelect) return { ...draft, selected: [label] };
      const selected = draft.selected.includes(label)
        ? draft.selected.filter((value) => value !== label)
        : [...draft.selected, label];
      // Keep the options' order, whatever order they were picked in.
      return {
        ...draft,
        selected: question.options.map((o) => o.label).filter((l) => selected.includes(l)),
      };
    });
  };

  const respond = (response: QuestionResponse) => {
    if (sent || readOnly) return;
    setSent(true);
    env.respondQuestion(item.requestId, response);
  };
  const send = () => {
    const unanswered = drafts.some(
      (draft) => draft.selected.length === 0 && draft.text.trim() === "",
    );
    if (unanswered) {
      setMissing(true);
      return;
    }
    respond({
      outcome: "answered",
      answers: questions.map((question, index) => {
        const draft = drafts[index] ?? { selected: [], text: "" };
        const text = draft.text.trim();
        return text
          ? { question: question.question, selected: draft.selected, text }
          : { question: question.question, selected: draft.selected };
      }),
    });
  };
  const dismiss = () => respond({ outcome: "dismissed" });
  /** Esc in an answer field only leaves it (onto Dismiss), so a typed answer is not lost. */
  const leaveOrDismiss = () => {
    if (isTextField(document.activeElement)) dismissRef.current?.focus();
    else dismiss();
  };
  const pickNumber = (n: number, target: HTMLElement) => {
    const holder = target.closest<HTMLElement>("[data-question-index]");
    const index = holder ? Number(holder.dataset.questionIndex) : 0;
    const option = questions[index]?.options[n - 1];
    if (option) toggle(index, option.label);
  };

  const single = questions.length === 1 ? questions[0] : undefined;
  const label = single ? `dawg is asking: ${single.question}` : "dawg is asking";
  return (
    <DecisionFrame
      icon="question"
      heading={readOnly ? "dawg asked" : "dawg is asking"}
      aside={
        single?.header ? (
          <span className={styles.headerChip}>
            <TextWithCode text={single.header} />
          </span>
        ) : null
      }
      label={readOnly ? label.replace("is asking", "asked") : label}
      shortcuts={
        readOnly || sent
          ? null
          : { primary: send, secondary: send, escape: leaveOrDismiss, number: pickNumber }
      }
      readOnly={readOnly}
    >
      {questions.map((question, index) => (
        <QuestionFields
          // biome-ignore lint/suspicious/noArrayIndexKey: the questions of a request never change
          key={index}
          question={question}
          index={index}
          draft={drafts[index] ?? { selected: [], text: "" }}
          readOnly={readOnly}
          showHeader={questions.length > 1}
          onToggle={(optionLabel) => toggle(index, optionLabel)}
          onText={(text) => update(index, (draft) => ({ ...draft, text }))}
          firstOptionRef={index === 0 ? firstOptionRef : undefined}
        />
      ))}
      {missing && (
        <p className={styles.error} role="alert">
          {questions.length > 1
            ? "Answer every question: pick an option or type an answer."
            : "Pick an option or type an answer."}
        </p>
      )}
      {readOnly ? (
        item.response?.outcome === "dismissed" && (
          <p className={styles.hint}>You dismissed this question.</p>
        )
      ) : (
        <div className={styles.actions}>
          <Button
            ref={sendRef}
            variant="primary"
            kbd="⏎"
            aria-keyshortcuts="Enter Meta+Enter"
            disabled={sent}
            onClick={send}
          >
            Send answer
          </Button>
          <Button
            ref={dismissRef}
            variant="ghost"
            kbd="esc"
            aria-keyshortcuts="Escape"
            disabled={sent}
            onClick={dismiss}
          >
            Dismiss
          </Button>
        </div>
      )}
    </DecisionFrame>
  );
}

export interface QuestionCardProps {
  item: QuestionItem;
  shownAgain: boolean;
  autoFocus: boolean;
  env: TranscriptEnv;
}

export const QuestionCard = memo(function QuestionCard({
  item,
  shownAgain,
  autoFocus,
  env,
}: QuestionCardProps) {
  if (item.state === "pending") {
    return <QuestionForm item={item} env={env} autoFocus={autoFocus} readOnly={false} />;
  }
  const answered = item.state === "answered" && item.response?.outcome === "answered";
  return (
    <div className={styles.answered}>
      <DecisionRecord
        icon={answered ? "check" : item.state === "cancelled" ? "clock" : "close"}
        text={questionRecord(item)}
        shown={shownAgain}
        onShowAgain={(shown) => env.showCardAgain(item.requestId, shown)}
      />
      {shownAgain && <QuestionForm item={item} env={env} autoFocus={false} readOnly />}
    </div>
  );
});
