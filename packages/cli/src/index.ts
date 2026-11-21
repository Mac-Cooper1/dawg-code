/** The `dawg` command-line tool. The executable is `main.ts`; this is its testable surface. */
export const packageName = "@dawg/cli";
export { type CliOptions, HELP, type OutputFormat, type ParsedArgs, parseArgs } from "./args.ts";
export { main, processIo } from "./cli.ts";
export { EXIT, type ExitCode } from "./exit-codes.ts";
export type { Io } from "./io.ts";
export { DEFAULT_CONTEXT_SIZE, NO_MODEL_MESSAGE, safeUrl } from "./models.ts";
export { profileIdForModel } from "./profiles.ts";
