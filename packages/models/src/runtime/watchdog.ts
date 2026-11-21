/**
 * Watchdog process that sits between the supervisor and llama-server:
 *
 *   supervisor ──(IPC channel = lifeline)──> watchdog ──> llama-server
 *
 * It exists so that llama-server can never outlive the app. When the supervisor's process dies
 * for any reason, including SIGKILL or a crash, the kernel closes the IPC channel; the watchdog
 * sees the disconnect (and, as a backstop, its parent pid changing), terminates llama-server
 * (SIGTERM, then SIGKILL after a grace period) and exits.
 *
 * Otherwise it is transparent: llama-server writes straight to the watchdog's stdout/stderr
 * (pipes owned by the supervisor), SIGTERM/SIGINT/SIGHUP are forwarded exactly once, and the
 * watchdog exits with llama-server's exit code or signal.
 *
 * Usage: node watchdog.ts [--grace-ms N] -- <binary> [args...]
 * Runs with Node built-ins only, so it works from source (.ts) and from the built package.
 */
import { spawn } from "node:child_process";
import type { WatchdogMessage } from "./watchdog-protocol.ts";

function send(message: WatchdogMessage): void {
  if (process.send && process.connected) {
    try {
      process.send(message);
    } catch {
      // The parent is gone; the lifeline handler deals with that.
    }
  }
}

function main(argv: string[]): void {
  const sep = argv.indexOf("--");
  if (sep === -1 || sep === argv.length - 1) {
    process.stderr.write("watchdog: usage: watchdog [--grace-ms N] -- <binary> [args...]\n");
    process.exit(2);
  }
  const own = argv.slice(0, sep);
  const graceIndex = own.indexOf("--grace-ms");
  const graceMs = graceIndex === -1 ? 5000 : Number(own[graceIndex + 1] ?? "5000");
  const [binary, ...args] = argv.slice(sep + 1) as [string, ...string[]];
  const parentPid = process.ppid;

  const child = spawn(binary, args, { stdio: ["ignore", "inherit", "inherit"] });
  let exited = false;
  let terminating = false;

  child.once("error", (error: NodeJS.ErrnoException) => {
    if (child.pid !== undefined) return;
    exited = true;
    send({ type: "spawn-error", message: error.message, code: error.code });
    process.exit(127);
  });
  child.once("spawn", () => {
    if (child.pid !== undefined) send({ type: "spawned", pid: child.pid });
  });
  child.once("exit", (code, signal) => {
    exited = true;
    send({ type: "exit", code, signal });
    const finish = () => {
      if (signal) {
        for (const s of FORWARDED) process.removeAllListeners(s);
        process.kill(process.pid, signal);
        // Signals such as SIGPIPE may be ignored by Node; fall back to an exit status.
        setTimeout(() => process.exit(128), 100).unref();
      } else {
        process.exit(code ?? 1);
      }
    };
    // Let the IPC message flush before exiting.
    setImmediate(finish);
  });

  const forward = (signal: NodeJS.Signals) => {
    if (exited || terminating) return;
    terminating = true;
    child.kill(signal);
  };
  for (const s of FORWARDED) process.on(s, () => forward(s));

  let lifelineLost = false;
  const onLifelineLost = () => {
    if (lifelineLost) return;
    lifelineLost = true;
    if (exited) process.exit(0);
    if (!terminating) {
      terminating = true;
      child.kill("SIGTERM");
    }
    const timer = setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, graceMs);
    timer.unref();
    // Exit on our own once llama-server is gone (the exit handler above), or after SIGKILL.
    setTimeout(() => process.exit(0), graceMs + 2000).unref();
  };
  if (process.send) {
    process.on("disconnect", onLifelineLost);
  }
  // Backstop: if we were re-parented, the supervisor is gone even if no IPC channel was set up.
  const poll = setInterval(() => {
    if (process.ppid !== parentPid) {
      send({ type: "orphaned" });
      onLifelineLost();
    }
  }, 500);
  poll.unref();
  // Keep the event loop alive while llama-server runs (the poll timer is unref'd).
  child.once("exit", () => clearInterval(poll));
}

const FORWARDED: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

main(process.argv.slice(2));
