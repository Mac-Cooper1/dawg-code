/**
 * The Electron side of the engine supervisor: starts the engine host as a utility process,
 * forwards its output to main's log, line by line, with a prefix, and hands its messages (model
 * requests, see shared/engine-host-messages.ts) to the supervisor.
 */
import { type MessagePortMain, utilityProcess } from "electron";
import type { SupervisedChild } from "./engine-supervisor.ts";

export interface EngineHostSpawnOptions {
  modulePath: string;
  env: Record<string, string>;
  log: (line: string) => void;
}

export function spawnEngineHost(options: EngineHostSpawnOptions): SupervisedChild<MessagePortMain> {
  const child = utilityProcess.fork(options.modulePath, [], {
    serviceName: "dawg-engine-host",
    stdio: "pipe",
    env: options.env,
  });
  forwardLines(child.stdout, (line) => options.log(`[engine-host] ${line}`));
  forwardLines(child.stderr, (line) => options.log(`[engine-host:err] ${line}`));
  child.on("error", (type, location) => {
    options.log(`[engine-host] fatal error (${type}) at ${location}`);
  });
  return {
    postMessage(message, transfer) {
      child.postMessage(message, transfer);
    },
    kill() {
      child.kill();
    },
    onExit(listener) {
      child.once("exit", (code) => listener(code));
    },
    onMessage(listener) {
      child.on("message", (message: unknown) => listener(message));
    },
  };
}

function forwardLines(stream: NodeJS.ReadableStream | null, write: (line: string) => void): void {
  if (!stream) return;
  let partial = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) if (line.trim() !== "") write(line);
  });
  stream.on("end", () => {
    if (partial.trim() !== "") write(partial);
    partial = "";
  });
}
