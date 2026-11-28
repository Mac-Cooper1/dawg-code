/**
 * Which files "Open file" may hand to the system: only agent, skill and command files, since
 * opening a file with the system can start a program.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkConfigFile, isConfigFilePath } from "./config-files.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-config-files-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(file: string, text = "---\nname: x\n---\n"): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

describe("config file paths", () => {
  it("names agent, skill and command files of .claude and .dawg folders", () => {
    for (const ok of [
      "/Users/me/.claude/agents/reviewer.md",
      "/Users/me/.dawg/agents/team/reviewer.md",
      "/Users/me/tally/.claude/skills/review/SKILL.md",
      "/Users/me/tally/.dawg/commands/frontend/test.md",
    ]) {
      expect(isConfigFilePath(ok), ok).toBe(true);
    }
    for (const bad of [
      "/Users/me/.claude/settings.json",
      "/Users/me/.claude/agents",
      "/Users/me/.claude/agents.md",
      "/Users/me/tally/agents/reviewer.md",
      "/Users/me/tally/.claude/hooks/run.md",
      "/Users/me/.claude/agents/run.command",
      "relative/.claude/agents/x.md",
    ]) {
      expect(isConfigFilePath(bad), bad).toBe(false);
    }
  });

  it("opens an existing file, and refuses a missing one, a folder, and a way out with ..", async () => {
    const file = await put(path.join(root, ".claude", "agents", "reviewer.md"));
    expect(await checkConfigFile(file)).toBe(await realpath(file));
    await expect(checkConfigFile(path.join(root, ".claude", "agents", "gone.md"))).rejects.toThrow(
      /not there any more/,
    );
    await mkdir(path.join(root, ".dawg", "agents", "folder.md"), { recursive: true });
    await expect(checkConfigFile(path.join(root, ".dawg", "agents", "folder.md"))).rejects.toThrow(
      /not a Markdown file/,
    );
    const outside = await put(path.join(root, "notes.md"));
    await expect(
      checkConfigFile(path.join(root, ".claude", "agents", "..", "..", "notes.md")),
    ).rejects.toThrow(/Only agent, skill and command files/);
    expect(outside).toContain("notes.md");
  });

  it("follows a link into a dotfiles folder, but only to a Markdown file", async () => {
    const dotfiles = await put(path.join(root, "dotfiles", "reviewer.md"));
    await mkdir(path.join(root, ".claude", "agents"), { recursive: true });
    await symlink(dotfiles, path.join(root, ".claude", "agents", "reviewer.md"));
    expect(await checkConfigFile(path.join(root, ".claude", "agents", "reviewer.md"))).toMatch(
      /dotfiles\/reviewer\.md$/,
    );
    const app = await put(path.join(root, "Tool.command"), "#!/bin/sh\necho hi\n");
    await symlink(app, path.join(root, ".claude", "agents", "sneaky.md"));
    await expect(
      checkConfigFile(path.join(root, ".claude", "agents", "sneaky.md")),
    ).rejects.toThrow(/not a Markdown file/);
  });
});
