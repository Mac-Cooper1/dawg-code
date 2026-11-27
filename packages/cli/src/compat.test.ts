/**
 * `dawg compat`: the arguments, the text and JSON reports, and the exit codes, run in process
 * against a temporary home and project.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CompatReportSchema } from "@dawg/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "./args.ts";
import { main } from "./cli.ts";
import { renderCompatReport, shortenHome } from "./compat.ts";
import { EXIT } from "./exit-codes.ts";
import type { Io } from "./io.ts";

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-cli-compat-"));
  home = path.join(root, "home");
  project = path.join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(rel: string, text: string): Promise<void> {
  const target = path.join(root, rel);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
}

function collect(stream: PassThrough): () => string {
  let text = "";
  stream.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return () => text;
}

async function run(args: string[], cwd = project) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  const err = collect(stderr);
  const io: Io = {
    stdin: new PassThrough(),
    stdout,
    stderr,
    env: { HOME: home, DAWG_HOME: path.join(home, ".dawg") },
    cwd,
    onSignal: () => () => {},
    exitNow: (code) => {
      throw new Error(`exit ${code}`);
    },
  };
  const code = await main(args, io);
  return { code, stdout: out(), stderr: err() };
}

async function setUp(): Promise<void> {
  await put("project/CLAUDE.md", "# Tally\n");
  await put(
    "project/.claude/settings.json",
    JSON.stringify({ permissions: { allow: ["Read"] }, theme: "dark", apiKeyHelper: "x" }),
  );
  await put(
    "project/.claude/agents/reviewer.md",
    "---\nname: reviewer\ndescription: Reviews\n---\nReview.\n",
  );
  await put("project/.mcp.json", JSON.stringify({ mcpServers: { db: { command: "db-mcp" } } }));
  await put("project/.claude/agents/broken.md", "---\nname: [x\n---\n");
}

describe("dawg compat: arguments", () => {
  it("takes a folder and --json, and nothing for sessions or models", () => {
    expect(parseArgs(["compat"])).toMatchObject({
      kind: "options",
      options: { command: "compat", path: null, json: false },
    });
    expect(parseArgs(["compat", "../tally", "--json"])).toMatchObject({
      kind: "options",
      options: { command: "compat", path: "../tally", json: true },
    });
    expect(parseArgs(["compat", "a", "b"])).toEqual({
      kind: "error",
      message: "dawg compat takes one folder.",
    });
    expect(parseArgs(["compat", "--model", "x", "-p"])).toEqual({
      kind: "error",
      message: "dawg compat takes a folder and --json, not --model, -p.",
    });
    expect(parseArgs(["-p", "hi", "--json"])).toEqual({
      kind: "error",
      message: "--json only applies to dawg compat.",
    });
    // A prompt that happens to start with the word is still a prompt after other words.
    expect(parseArgs(["-p", "compat"])).toMatchObject({
      options: { command: "run", prompt: "compat" },
    });
  });
});

describe("dawg compat", () => {
  it("prints the report in the spec's sections, with paths from ~ and notes", async () => {
    await setUp();
    const result = await run(["compat"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(EXIT.ok);
    const text = result.stdout;
    const p = shortenHome(project, home);
    expect(text).toContain(`Claude Code setup for ${p} and your home folder`);
    const order = [
      "Loaded (2)",
      "Needs approval (1)",
      "Partly supported (1)",
      "Not supported (0)",
      "Invalid (1)",
    ];
    let at = -1;
    for (const heading of order) {
      const next = text.indexOf(`\n${heading}\n`);
      expect(next, heading).toBeGreaterThan(at);
      at = next;
    }
    expect(text).toContain("Instructions  CLAUDE.md  (project, Claude Code)");
    expect(text).toContain(`${p}/CLAUDE.md`);
    expect(text).toContain("Settings      .claude/settings.json  (project, Claude Code)");
    expect(text).toContain("- Not used by dawg yet: theme.");
    expect(text).toContain("- Depends on Anthropic's cloud or an Anthropic account");
    // Subagent files load (Phase 4, subagents).
    const loaded = text.slice(text.indexOf("\nLoaded (2)\n"), text.indexOf("\nNeeds approval"));
    expect(loaded).toContain("Subagent      reviewer  (project, Claude Code)");
    expect(text).toContain("MCP server    db  (project, Claude Code)");
    expect(text).toContain("Subagent      broken");
    // The project's MCP server waits for consent (spec, principle 3) before it starts.
    const waiting = text.slice(
      text.indexOf("\nNeeds approval (1)\n"),
      text.indexOf("\nPartly supported"),
    );
    expect(waiting).toContain("MCP server    db  (project, Claude Code)");
    expect(text).toContain("1 definition of code from this setup waits for your consent");
    // Nothing is written to the project or the home folder's Claude Code files.
  });

  it("reports on another folder, and prints JSON with --json", async () => {
    await setUp();
    const result = await run(["compat", "project", "--json"], root);
    expect(result.code).toBe(EXIT.ok);
    const report = CompatReportSchema.parse(JSON.parse(result.stdout));
    expect(report.projectDir).toBe(project);
    expect(report.approval).toMatchObject({
      approved: false,
      items: [{ kind: "mcp-server", name: "db", status: "needs-approval" }],
    });
    expect(report.items.map((item) => [item.kind, item.name, item.status])).toEqual([
      ["instructions", "CLAUDE.md", "loaded"],
      ["settings", ".claude/settings.json", "partly-supported"],
      ["agent", "broken", "invalid"],
      ["agent", "reviewer", "loaded"],
      ["mcp-server", "db", "needs-approval"],
    ]);
    expect(report.items[0]?.source.path).toBe(path.join(project, "CLAUDE.md"));
  });

  it("says when there is nothing to report", async () => {
    const result = await run(["compat"]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("Loaded (0)\n  None.");
    expect(result.stdout).toContain("Invalid (0)\n  None.");
  });

  it("refuses a path that is not a folder with the usage exit code", async () => {
    const missing = await run(["compat", "nowhere"]);
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toBe(
      `dawg: ${shortenHome(path.join(project, "nowhere"), home)} is not a folder.\n`,
    );
    await put("project/file.txt", "x");
    const file = await run(["compat", "file.txt"]);
    expect(file.code).toBe(EXIT.usage);
    const bad = await run(["compat", "--frobnicate"]);
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.stderr).toContain("Unknown option --frobnicate");
  });

  it("says what consent the setup's code has", () => {
    const base = { projectDir: null, items: [] };
    const item = {
      kind: "hook" as const,
      name: "PreToolUse on Bash: ./check.sh",
      source: {
        path: "/p/.claude/settings.json",
        origin: "claude" as const,
        scope: "project" as const,
      },
      status: "needs-approval" as const,
      notes: [],
    };
    const waiting = renderCompatReport(
      { ...base, approval: { hash: "h", approved: false, items: [item, item] } },
      "/home",
    );
    expect(waiting).toContain(
      "2 definitions of code from this setup wait for your consent before they run. Review them in the app, in Settings → Project setup.",
    );
    const approved = renderCompatReport(
      { ...base, approval: { hash: "h", approved: true, items: [item] } },
      "/home",
    );
    expect(approved).toContain("You approved the 1 definition of code from this setup.");
    expect(approved.startsWith("Claude Code setup in your home folder\n")).toBe(true);
  });
});
