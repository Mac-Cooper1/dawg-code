/**
 * `/mcp` on the command line: the session's servers and their state, and the import of Claude
 * Code's own servers, which shows what would be copied before it copies anything.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./__fixtures__/harness.ts";
import { EXIT } from "./exit-codes.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe("/mcp", () => {
  it("lists the servers, and imports Claude Code's only with the code it showed", async () => {
    h = await startHarness({ script: [] });
    await writeFile(
      path.join(h.home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "gh"], env: { GITHUB_TOKEN: "ghp_x" } },
        },
      }),
    );
    await mkdir(path.join(h.home, ".dawg"), { recursive: true });
    await writeFile(
      path.join(h.home, ".dawg", "mcp.json"),
      JSON.stringify({ mcpServers: { broken: { type: "http" } } }),
    );
    const child = h.spawn(["--endpoint", h.mock.baseUrl]);
    const stdin = child.process.stdin;
    if (stdin === null) throw new Error("no stdin");
    stdin.write("/mcp\n");
    await child.waitForStdout("dawg has not imported");
    stdin.write("/mcp import\n");
    await child.waitForStdout(/run `\/mcp import [0-9a-f]{8}`/);
    const code = /\/mcp import ([0-9a-f]{8})/.exec(child.stdout())?.[1] ?? "";
    // Nothing is copied by looking.
    await expect(readFile(path.join(h.home, ".dawg", "mcp.json"), "utf8")).resolves.not.toContain(
      "github",
    );
    stdin.write("/mcp import 00000000\n");
    stdin.write(`/mcp import ${code}\n`);
    await child.waitForStdout("Copied 1 server into");
    stdin.end();
    const result = await child.exited;
    expect(result.code).toBe(EXIT.ok);
    const out = result.stdout;
    expect(out).toContain("**broken** (yours, not runnable): failed: Its definition is not valid");
    expect(out).toContain("Copies **github** (every project): npx -y gh.");
    expect(out).toContain("Copies values that may be secrets: env GITHUB_TOKEN.");
    expect(out).not.toContain("ghp_x");
    expect(result.stderr).toContain("That code does not match what there is to import now.");
    const written = JSON.parse(await readFile(path.join(h.home, ".dawg", "mcp.json"), "utf8"));
    expect(written.mcpServers.github).toEqual({
      command: "npx",
      args: ["-y", "gh"],
      env: { GITHUB_TOKEN: "ghp_x" },
    });
  });
});
