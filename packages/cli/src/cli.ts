/** The `dawg` command's dispatch, and the process's streams and signals. */
import { HELP, parseArgs } from "./args.ts";
import { runCompat } from "./compat.ts";
import { cliVersion } from "./engine.ts";
import { EXIT } from "./exit-codes.ts";
import { runHeadless } from "./headless.ts";
import { runInteractive } from "./interactive.ts";
import type { Io } from "./io.ts";
import { runServe } from "./serve.ts";

export function processIo(): Io {
  const handlers = new Set<(signal: "SIGINT" | "SIGTERM") => void>();
  const dispatch = (signal: "SIGINT" | "SIGTERM") => {
    if (handlers.size === 0)
      process.exit(signal === "SIGTERM" ? EXIT.terminated : EXIT.interrupted);
    for (const handler of [...handlers]) handler(signal);
  };
  process.on("SIGINT", () => dispatch("SIGINT"));
  process.on("SIGTERM", () => dispatch("SIGTERM"));
  // A reader that went away (`dawg -p ... | head -1`) is not an error worth a stack trace.
  process.stdout.on("error", () => {});
  // The key is for the model endpoint alone. Taken out of the process environment, it is not
  // inherited by the commands the agent runs, which could otherwise print it.
  const env = { ...process.env };
  delete process.env.DAWG_API_KEY;
  // Likewise the search service's key (WebSearch reads it from `env`).
  delete process.env.DAWG_SEARCH_API_KEY;
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env,
    cwd: process.cwd(),
    onSignal(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    exitNow(code): never {
      process.exit(code);
    },
  };
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const parsed = parseArgs(argv);
  switch (parsed.kind) {
    case "help":
      io.stdout.write(HELP);
      return EXIT.ok;
    case "version":
      io.stdout.write(`dawg ${cliVersion()}\n`);
      return EXIT.ok;
    case "error":
      io.stderr.write(`dawg: ${parsed.message}\nRun dawg --help for the options.\n`);
      return EXIT.usage;
    case "options": {
      const { options } = parsed;
      if (options.command === "serve") return runServe(options, io);
      if (options.command === "compat") return runCompat(options, io);
      if (options.print) return runHeadless(options, io);
      return runInteractive(options, io);
    }
  }
}
