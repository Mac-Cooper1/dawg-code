/** Where the test server is, and how to start it over HTTP, for the MCP tests. */
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const TEST_SERVER = fileURLToPath(new URL("./test-server.ts", import.meta.url));

/** Starts the test server over HTTP or SSE and resolves with its address. */
export async function startHttpServer(
  transport: "http" | "sse",
  extra: string[] = [],
): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn(process.execPath, [TEST_SERVER, "--transport", transport, ...extra], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const url = await new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.stdout?.once("data", (data: Buffer) => resolve(JSON.parse(String(data)).url));
  });
  return { url, child };
}
