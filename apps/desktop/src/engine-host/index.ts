/**
 * The engine host: an Electron utility process started (and restarted) by main. It serves the
 * engine protocol on every message port main hands it, one connection per window.
 *
 * Output goes to stdout/stderr, which main forwards to its log with an "[engine-host]" prefix.
 */
import { homedir } from "node:os";
import { createHostedEngine, parseSpeed } from "./engine.ts";
import { startEngineHost } from "./host.ts";

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

const homeDir =
  process.env.HOME !== undefined && process.env.HOME !== "" ? process.env.HOME : homedir();
const speed = parseSpeed(process.env.DAWG_MOCK_SPEED, log);

startEngineHost(parentPort, () => createHostedEngine({ homeDir, speed }), log);
