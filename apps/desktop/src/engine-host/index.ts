/**
 * The engine host: an Electron utility process started (and restarted) by main. It runs one
 * engine and serves the engine protocol on every message port main hands it, one connection per
 * window.
 *
 * Environment, set by main:
 * - DAWG_ENGINE: "mock" replays recorded sessions (`src/mock-engine`); unset or "real" runs
 *   `@dawg/engine`, which asks main for models over the parent port.
 * - DAWG_HOME: the data root (default `~/.dawg`). HOME: the person's home directory.
 * - DAWG_RESOURCES_DIR: the app's resources folder; the bundled ripgrep is
 *   `bin/<platform>-<arch>/rg` in it. Without it, ripgrep is looked up (DAWG_RG_PATH, the
 *   checkout's fetched copy, PATH).
 * - DAWG_MOCK_SPEED: the mock engine's playback speed.
 * - DAWG_MOCK_LONG_SESSION: with the mock engine, adds a synthetic session of that many
 *   transcript items, for the performance tests (`src/mock-engine/long-session.ts`).
 *
 * Main stops the host with SIGTERM: the engine closes its sessions (a running turn is
 * interrupted, transcripts are flushed, locks released) before the process exits.
 *
 * Output goes to stdout/stderr, which main forwards to its log with an "[engine-host]" prefix.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolveDawgHome } from "@dawg/engine";
import { parseLongSession } from "../mock-engine/long-session.ts";
import { createHostedEngine, type EngineConfig, parseEngineKind, parseSpeed } from "./engine.ts";
import { startEngineHost } from "./host.ts";
import { bundledRipgrepPath } from "./real-engine.ts";

/** How long closing the engine may take before the process exits anyway. */
const STOP_DEADLINE_MS = 5_000;

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

const parentPort = process.parentPort;
if (!parentPort) {
  log("The engine host must run as an Electron utility process (no parentPort).");
  process.exit(64);
}

process.on("uncaughtException", (error) => {
  log(`Uncaught exception: ${error.stack ?? error.message}`);
  // Main restarts the host; a half-broken engine is worse than a fresh one.
  process.exit(70);
});
process.on("unhandledRejection", (reason) => {
  log(
    `Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
});

const env = process.env;
const homeDir = env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();

function engineConfig(): EngineConfig {
  if (parseEngineKind(env.DAWG_ENGINE, log) === "mock") {
    return {
      kind: "mock",
      homeDir,
      speed: parseSpeed(env.DAWG_MOCK_SPEED, log),
      longSession: parseLongSession(env.DAWG_MOCK_LONG_SESSION, log),
    };
  }
  const resources = env.DAWG_RESOURCES_DIR;
  let ripgrepPath: string | null = null;
  if (resources !== undefined && resources !== "") {
    ripgrepPath = bundledRipgrepPath(resources);
    if (!existsSync(ripgrepPath)) {
      log(`No ripgrep at ${ripgrepPath}; Grep and Glob will look for one elsewhere.`);
    }
  }
  return {
    kind: "real",
    homeDir,
    dataRoot: resolveDawgHome({ env, homeDir }),
    ripgrepPath,
    log,
  };
}

const { engine } = startEngineHost(
  parentPort,
  (send) => createHostedEngine(engineConfig(), send),
  log,
);

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`Stopping (${signal}).`);
  const deadline = setTimeout(() => {
    log("The engine did not close in time; exiting anyway.");
    process.exit(0);
  }, STOP_DEADLINE_MS);
  try {
    await engine?.dispose();
  } catch (error) {
    log(`Closing the engine failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  clearTimeout(deadline);
  process.exit(0);
}
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
