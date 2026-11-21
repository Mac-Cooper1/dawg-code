import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { splitArgs } from "./proc.ts";

export interface ProxyOptions {
  /** Command that launches the proxy, as argv words (defaults: node <repo>/evals/proxy/src/cli.ts). */
  command: string[];
  /** Upstream base URL ending in /v1. */
  upstream: string;
  recordPath: string;
  /** Name of the env var holding the real upstream key. Its value is never read by the runner. */
  upstreamKeyEnv?: string;
  label?: string;
  /** Where the proxy's stderr goes. */
  stderrPath: string;
  startTimeoutMs?: number;
}

export interface RunningProxy {
  port: number;
  /** SIGTERM, wait for exit (so records are flushed), SIGKILL after a grace period. */
  stop(): Promise<void>;
}

export function defaultProxyCommand(repoRoot: string): string[] {
  return [process.execPath, join(repoRoot, "evals", "proxy", "src", "cli.ts")];
}

export function parseProxyCommand(s: string): string[] {
  const words = splitArgs(s);
  if (words.length === 0) throw new Error("--proxy-cmd is empty");
  return words;
}

/** Starts the recording proxy and waits for its {"event":"listening","port":n} line. */
export function startProxy(opts: ProxyOptions): Promise<RunningProxy> {
  const [cmd, ...pre] = opts.command as [string, ...string[]];
  const args = [...pre, "--upstream", opts.upstream, "--port", "0", "--record", opts.recordPath];
  if (opts.upstreamKeyEnv) args.push("--upstream-key-env", opts.upstreamKeyEnv);
  if (opts.label) args.push("--label", opts.label);

  const errFd = openSync(opts.stderrPath, "a");
  // The proxy is trusted infrastructure: it inherits the runner's env, which holds the real key.
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", errFd] });
  closeSync(errFd);

  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const t = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(t);
  };

  return new Promise<RunningProxy>((resolve, reject) => {
    let done = false;
    const fail = (msg: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void stop();
      reject(new Error(`recording proxy: ${msg} (stderr: ${opts.stderrPath})`));
    };
    const timer = setTimeout(
      () => fail("did not report listening in time"),
      opts.startTimeoutMs ?? 15_000,
    );
    child.once("error", (err) => fail(`could not start: ${err.message}`));
    child.once("exit", (code, sig) => fail(`exited before listening (${code ?? sig})`));

    const stdout = child.stdout;
    if (!stdout) return fail("no stdout pipe");
    const rl = createInterface({ input: stdout });
    rl.on("line", (line) => {
      if (done) return;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (
        msg !== null &&
        typeof msg === "object" &&
        (msg as { event?: unknown }).event === "listening" &&
        typeof (msg as { port?: unknown }).port === "number"
      ) {
        done = true;
        clearTimeout(timer);
        resolve({ port: (msg as { port: number }).port, stop });
      }
    });
  });
}
