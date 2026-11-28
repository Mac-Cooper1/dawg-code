/**
 * `dawg compat [path]`: what dawg makes of the Claude Code setup in a folder and the person's home
 * (Phase 4 spec, "Compatibility report"). The report comes through the protocol's
 * `project.inspect`, as the app gets it, so it carries the engine's consent for the code the
 * setup supplies. No model is needed.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import type { CompatItem, CompatReport } from "@dawg/protocol";
import type { CliOptions } from "./args.ts";
import { buildEngine, connectInProcess, resolvePaths } from "./engine.ts";
import { EXIT } from "./exit-codes.ts";
import type { Io } from "./io.ts";
import type { ModelSetup } from "./models.ts";

/** `dawg compat` reads files; it never talks to a model. */
const NO_MODEL: ModelSetup = {
  provider: {
    connect: () => Promise.reject(new Error("dawg compat does not use a model.")),
  },
  defaultModel: "",
  describe: () => null,
  close: async () => {},
};

/** The report's sections, in the order the spec lists them, with Invalid last. */
export const SECTIONS: readonly { status: CompatItem["status"]; title: string }[] = [
  { status: "loaded", title: "Loaded" },
  { status: "needs-approval", title: "Needs approval" },
  { status: "partly-supported", title: "Partly supported" },
  { status: "not-supported", title: "Not supported" },
  { status: "invalid", title: "Invalid" },
];

const KIND_LABEL: Record<CompatItem["kind"], string> = {
  instructions: "Instructions",
  settings: "Settings",
  command: "Command",
  skill: "Skill",
  agent: "Subagent",
  hook: "Hook",
  "mcp-server": "MCP server",
  other: "Other",
};

const SCOPE_LABEL: Record<CompatItem["source"]["scope"], string> = {
  user: "yours",
  project: "project",
  local: "yours, this project",
  nested: "folder in the project",
  flags: "command line",
};

/** A path with the home folder written as `~`. */
export function shortenHome(target: string, homeDir: string): string {
  const home = path.resolve(homeDir);
  if (target === home) return "~";
  return target.startsWith(`${home}${path.sep}`) ? `~${target.slice(home.length)}` : target;
}

/** The report as text, in the spec's sections. */
export function renderCompatReport(report: CompatReport, homeDir: string): string {
  const lines: string[] = [];
  lines.push(
    report.projectDir === null
      ? "Claude Code setup in your home folder"
      : `Claude Code setup for ${shortenHome(report.projectDir, homeDir)} and your home folder`,
  );
  // Code waiting for consent counts under Needs approval even when its own status says more
  // (an MCP server, which does not run yet, is also Not supported).
  const waiting =
    report.approval !== null && !report.approval.approved ? report.approval.items : [];
  const all = [...report.items, ...waiting];
  const width = Math.max(...all.map((item) => KIND_LABEL[item.kind].length), 0);
  for (const section of SECTIONS) {
    let items = report.items.filter((item) => item.status === section.status);
    if (section.status === "needs-approval") {
      const listed = new Set(items.map(itemKey));
      items = [...items, ...waiting.filter((item) => !listed.has(itemKey(item)))];
    }
    lines.push("", `${section.title} (${items.length})`);
    if (items.length === 0) {
      lines.push("  None.");
      continue;
    }
    for (const item of items) {
      const origin = item.source.origin === "claude" ? "Claude Code" : "dawg";
      lines.push(
        `  ${KIND_LABEL[item.kind].padEnd(width)}  ${item.name}  (${SCOPE_LABEL[item.source.scope]}, ${origin})`,
      );
      const indent = " ".repeat(width + 4);
      lines.push(`${indent}${shortenHome(item.source.path, homeDir)}`);
      for (const note of item.notes) lines.push(`${indent}- ${note}`);
    }
  }
  lines.push("", approvalLine(report));
  return `${lines.join("\n")}\n`;
}

function itemKey(item: CompatItem): string {
  return `${item.kind}\u0000${item.name}\u0000${item.source.path}`;
}

function approvalLine(report: CompatReport): string {
  const approval = report.approval;
  if (approval === null) return "Nothing in this setup runs code that needs your consent.";
  const count = approval.items.length;
  const what = `${count} ${count === 1 ? "definition" : "definitions"} of code from this setup`;
  return approval.approved
    ? `You approved the ${what}.`
    : `${what[0]?.toUpperCase()}${what.slice(1)} ${count === 1 ? "waits" : "wait"} for your consent before ${count === 1 ? "it runs" : "they run"}. Review ${count === 1 ? "it" : "them"} in the app, in Settings → Project setup.`;
}

export async function runCompat(options: CliOptions, io: Io): Promise<number> {
  const paths = resolvePaths(io.env);
  const target = path.resolve(io.cwd, options.path ?? ".");
  let isFolder = false;
  try {
    isFolder = (await stat(target)).isDirectory();
  } catch {
    isFolder = false;
  }
  if (!isFolder) {
    io.stderr.write(`dawg: ${shortenHome(target, paths.homeDir)} is not a folder.\n`);
    return EXIT.usage;
  }
  const verbose = options.verbose ? (line: string) => io.stderr.write(`${line}\n`) : () => {};
  const engine = buildEngine({ options, paths, models: NO_MODEL, generateTitles: false });
  try {
    const { client, host } = await connectInProcess({
      engine,
      options,
      paths,
      models: NO_MODEL,
      capabilities: {
        permissionPrompts: false,
        questions: false,
        planApproval: false,
        elicitation: false,
      },
      onProblem: verbose,
    });
    try {
      const report = await client.request("project.inspect", { projectDir: target });
      io.stdout.write(
        options.json
          ? `${JSON.stringify(report, null, 2)}\n`
          : renderCompatReport(report, paths.homeDir),
      );
      return EXIT.ok;
    } finally {
      client.close();
      await host.done;
    }
  } catch (error) {
    io.stderr.write(
      `dawg: could not make the report: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT.error;
  } finally {
    await engine.close().catch(() => {});
  }
}
