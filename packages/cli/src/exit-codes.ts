/** Exit codes of the `dawg` command. Documented in README.md and `dawg --help`. */
export const EXIT = {
  /** The turn completed (or the command answered). */
  ok: 0,
  /** The model or the engine failed: unreachable endpoint, model error, a failed turn. */
  error: 1,
  /** Bad usage: unknown flag, missing prompt, no model configured, a refused setting. */
  usage: 2,
  /** The turn stopped at the `--max-turns` limit. */
  turnLimit: 3,
  /** Interrupted with SIGINT (128 + 2). */
  interrupted: 130,
  /** Stopped with SIGTERM (128 + 15). */
  terminated: 143,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
