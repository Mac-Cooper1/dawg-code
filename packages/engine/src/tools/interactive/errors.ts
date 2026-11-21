/**
 * How a session tells an interactive tool that its request could not be put to a person. The
 * `SessionServices` contract only says that `askUser` and `proposePlan` reject when the turn is
 * interrupted; these two errors let the tools tell the other cases apart and answer the model
 * with something it can act on instead of an interruption.
 */

/** Nobody can answer: the client cannot show questions or plans (a headless run). */
export class NoOneToAskError extends Error {
  override name = "NoOneToAskError";
}

/** The person closed the question or plan card without answering. */
export class RequestDismissedError extends Error {
  override name = "RequestDismissedError";
  /** What the person said while dismissing, if anything. */
  readonly note: string | null;

  constructor(note: string | null = null) {
    super(note === null ? "The request was dismissed." : `The request was dismissed: ${note}`);
    this.note = note;
  }
}
