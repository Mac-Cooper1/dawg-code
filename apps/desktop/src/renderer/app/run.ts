/**
 * Store actions that talk to the engine return promises. UI handlers fire them and move on; the
 * state layer reports failures to the person (notices, error items), so here a rejection is only
 * logged instead of surfacing as an unhandled rejection.
 */
export function run(task: Promise<unknown>): void {
  Promise.resolve(task).catch((error: unknown) => {
    console.error("dawg-code: an action failed", error);
  });
}
