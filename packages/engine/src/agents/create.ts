/**
 * `subagent.create`: writes a new agent file for Settings → Subagents' "New subagent" form, in
 * the documented front matter format (compat's `renderAgentFile`), as `<name>.md` in the
 * person's `~/.dawg/agents` or the project's `.dawg/agents`. Never under `.claude` (principle 1:
 * Claude Code's files are read-only), and never over a file that is there already. New sessions
 * pick the file up; open ones keep the agents they started with, so their prompt cache holds.
 *
 * A project file that grants tools is project-supplied power like any other: it waits for the
 * person to approve the project's code (the listing says so); nothing here works around that.
 */
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { newAgentNameProblem, renderAgentFile } from "@dawg/compat";
import type { MethodParams, SubagentDefinition } from "@dawg/protocol";
import { RuntimeError } from "../runtime/errors.ts";
import { agentFolders, type ProjectSubagentsInput, projectSubagents } from "./list.ts";

export type CreateSubagentParams = MethodParams<"subagent.create">;

function clean(list: readonly string[] | null | undefined): string[] {
  return (list ?? []).map((entry) => entry.trim()).filter((entry) => entry !== "");
}

/** A path as a person reads it in a message: from the home folder with `~`, else in full. */
function shown(file: string, homeDir: string): string {
  const rel = path.relative(path.resolve(homeDir), file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
    ? `~/${rel.split(path.sep).join("/")}`
    : file;
}

export async function createSubagent(
  input: Omit<ProjectSubagentsInput, "projectDir">,
  params: CreateSubagentParams,
): Promise<{ path: string; agent: SubagentDefinition }> {
  const name = params.name.trim();
  const problem = newAgentNameProblem(name);
  if (problem !== null) throw new RuntimeError("InvalidParams", problem);
  const description = params.description.replace(/\s+/g, " ").trim();
  if (description === "") {
    throw new RuntimeError(
      "InvalidParams",
      "Give the subagent a description: it tells the agent when to hand it a task.",
    );
  }
  const projectDir = params.projectDir;
  if (projectDir !== null && !path.isAbsolute(projectDir)) {
    throw new RuntimeError("InvalidParams", "projectDir must be an absolute path.");
  }
  const folders = agentFolders(input.homeDir, projectDir);
  const dir = params.scope === "user" ? folders.user : folders.project;
  if (dir === null) {
    throw new RuntimeError("InvalidParams", "A project subagent needs a project.");
  }

  await mkdir(dir, { recursive: true });
  // A `.dawg` folder that leads into a `.claude` one is still Claude Code's: never write there.
  const real = await realpath(dir);
  if (real.split(path.sep).includes(".claude")) {
    throw new RuntimeError(
      "InvalidState",
      `${shown(dir, input.homeDir)} leads into a .claude folder, which dawg never writes to.`,
    );
  }
  const file = path.join(dir, `${name}.md`);
  const tools = params.tools === undefined || params.tools === null ? null : clean(params.tools);
  const text = renderAgentFile({
    name,
    description,
    prompt: params.prompt ?? "",
    tools: tools !== null && tools.length === 0 ? null : tools,
    disallowedTools: clean(params.disallowedTools),
    model: params.model?.trim() || null,
    permissionMode: params.permissionMode ?? null,
    memory: params.memory ?? null,
    background: params.background === true,
    isolation: params.isolation ?? null,
  });
  try {
    await writeFile(file, text, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new RuntimeError(
        "InvalidState",
        `${shown(file, input.homeDir)} already exists, so it was left as it is. Choose another name, or edit that file.`,
      );
    }
    throw error;
  }
  const listing = await projectSubagents({ ...input, projectDir });
  const agent = listing.agents.find((a) => a.source?.path === file);
  if (agent === undefined) {
    throw new RuntimeError(
      "InvalidState",
      `${shown(file, input.homeDir)} was written but could not be read back.`,
    );
  }
  return { path: file, agent };
}
