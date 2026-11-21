/**
 * `dawg serve`: the engine protocol over standard input and output, newline-delimited JSON, for
 * another process to drive. Standard output carries protocol messages and nothing else;
 * diagnostics go to standard error.
 *
 * When the input ends (the driving process closed it or died), every session is closed, a
 * running turn interrupted first, and the process exits 0. SIGINT and SIGTERM do the same.
 */
import { createEngineHost } from "@dawg/engine";
import { createNdjsonTransport, DEFAULT_MAX_LINE_LENGTH } from "@dawg/protocol";
import type { CliOptions } from "./args.ts";
import { buildEngine, cliVersion, settingsFlagsFrom } from "./engine.ts";
import { EXIT } from "./exit-codes.ts";
import type { Io } from "./io.ts";
import { runErrorFrom } from "./session.ts";
import { startModels } from "./start.ts";

export async function runServe(options: CliOptions, io: Io): Promise<number> {
  const log = (line: string) => io.stderr.write(`${line}\n`);
  const verbose = options.verbose ? log : () => {};
  let signalled: number | null = null;
  let stop: (() => void) | null = null;
  const stopSignals = io.onSignal((signal) => {
    if (signalled !== null || stop === null)
      io.exitNow(signal === "SIGTERM" ? EXIT.terminated : EXIT.interrupted);
    signalled = signal === "SIGTERM" ? EXIT.terminated : EXIT.interrupted;
    stop();
  });
  try {
    const { paths, models } = await startModels(options, io, verbose);
    try {
      const engine = buildEngine({ options, paths, models, generateTitles: true });
      const transport = createNdjsonTransport({ input: io.stdin, output: io.stdout });
      const host = createEngineHost(engine, transport, {
        engineInfo: { name: "dawg", version: cliVersion() },
        homeDir: paths.homeDir,
        settingsFlags: settingsFlagsFrom(options),
        describeEndpoint: (session) => models.describe(session.modelInfo().id),
        detachGraceMs: 0,
        maxMessageLength: DEFAULT_MAX_LINE_LENGTH,
        onProblem: (p) => verbose(`${p.kind}: ${p.message}`),
      });
      stop = () => {
        void host.close();
      };
      verbose(`Serving the engine protocol on standard input and output.`);
      await host.done;
      await engine.close().catch(() => {});
    } finally {
      await models.close();
    }
    return signalled ?? EXIT.ok;
  } catch (error) {
    const failure = runErrorFrom(error);
    log(`Error: ${failure.message}`);
    return failure.exitCode;
  } finally {
    stopSignals();
  }
}
