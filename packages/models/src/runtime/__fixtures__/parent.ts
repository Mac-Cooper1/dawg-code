/**
 * A stand-in for the app process, for the parent-death tests. Starts a supervisor, prints the
 * watchdog and llama-server pids as one JSON line, then idles until it is killed. Writing
 * "crash" to stdin makes it die from an uncaught exception.
 *
 * Usage: node parent.ts <binary> <model> <workDir> [stopGraceMs]
 */
import { join } from "node:path";
import { RuntimeSupervisor } from "../supervisor.ts";

const [binary, model, work, grace] = process.argv.slice(2);
if (!binary || !model || !work) {
  process.stderr.write("usage: parent.ts <binary> <model> <workDir> [stopGraceMs]\n");
  process.exit(2);
}

const supervisor = new RuntimeSupervisor({
  binary,
  model: { path: model },
  contextSize: 4096,
  slots: 1,
  settings: { cacheRamMiB: 0, ctxCheckpoints: 0, checkpointMinStep: 0 },
  paths: { slotSaveDir: join(work, "slots"), logDir: join(work, "logs"), keyDir: join(work, "keys") },
  timing: { healthIntervalMs: 20, stopGraceMs: Number(grace ?? "1000") },
});

await supervisor.start();
process.stdout.write(`${JSON.stringify({ parent: process.pid, ...supervisor.processIds })}\n`);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (text: string) => {
  if (text.includes("crash")) {
    setImmediate(() => {
      throw new Error("simulated crash of the app process");
    });
  }
});
setInterval(() => {}, 60_000);
