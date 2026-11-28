/**
 * `/mcp login <name>` at the terminal (interactive mode only; a `-p` run never starts a sign-in):
 * the engine starts the sign-in (`mcp.signIn`), and this prints the address and opens it in the
 * browser, then says, once, how the sign-in ended. The engine waits for the browser's return on
 * 127.0.0.1 and connects the server itself.
 *
 * The browser: `$BROWSER` when it is set (`none` only prints the address, as the tests set it),
 * else `open` on macOS and `xdg-open` on Linux.
 */
import { spawn } from "node:child_process";
import type { Client, SessionSummary } from "@dawg/protocol";

/** How often the sign-in is looked at while it waits for the browser. */
const FOLLOW_MS = 1_000;
/** When to stop looking: the engine gives up after five minutes. */
const FOLLOW_FOR_MS = 6 * 60_000;

/** The command that opens a web address, or null to print it only. */
export function browserCommand(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string[] | null {
  const chosen = env.BROWSER?.trim();
  if (chosen !== undefined && chosen !== "") {
    return chosen.toLowerCase() === "none" ? null : chosen.split(/\s+/);
  }
  if (platform === "darwin") return ["open"];
  if (platform === "linux") return ["xdg-open"];
  return null;
}

/** Opens `url` in the browser without waiting. False when there is no way to, or it failed. */
export function openInBrowser(
  url: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const command = browserCommand(env, platform);
  if (command === null) return Promise.resolve(false);
  const [program, ...args] = command as [string, ...string[]];
  return new Promise((resolve) => {
    try {
      const child = spawn(program, [...args, url], { detached: true, stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

export async function signInFromTerminal(
  client: Client,
  session: Pick<SessionSummary, "id" | "projectDir">,
  name: string,
  io: {
    line(text: string): void;
    env: Readonly<Record<string, string | undefined>>;
    platform?: NodeJS.Platform;
  },
): Promise<void> {
  const where = { projectDir: session.projectDir, name, sessionId: session.id };
  const { url } = await client.request("mcp.signIn", where);
  const opened = await openInBrowser(url, io.env, io.platform);
  io.line(
    opened
      ? `Finish signing in to ${name} in your browser. If it did not open, visit:`
      : `To sign in to ${name}, open this address in your browser:`,
  );
  io.line(url);
  io.line("dawg waits five minutes for the browser to come back, then connects.");

  // One line when it ends, while the prompt stays free for other work.
  const until = Date.now() + FOLLOW_FOR_MS;
  const look = async () => {
    try {
      const { servers } = await client.request("mcp.list", where);
      const server = servers.find((s) => s.name === name);
      const signIn = server?.signIn ?? null;
      if (signIn?.status === "signing-in" && Date.now() < until) {
        setTimeout(() => void look(), FOLLOW_MS).unref();
        return;
      }
      if (signIn?.status === "signed-in") io.line(`Signed in to ${name}.`);
      else if (signIn?.problem != null) io.line(`Not signed in to ${name}: ${signIn.problem}`);
    } catch {
      // The run is ending: nobody is left to tell.
    }
  };
  setTimeout(() => void look(), FOLLOW_MS).unref();
}
