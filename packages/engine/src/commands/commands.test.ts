import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { text } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import { ask, type Setup, setup } from "../host/__fixtures__/setup.ts";
import { RuntimeError } from "../runtime/errors.ts";
import type { SessionRuntime } from "../runtime/session.ts";
import { createCommandRegistry } from "./index.ts";
import { chooseInstructionFile } from "./init.ts";
import { CommandRegistry, parseSlashCommand, splitArguments } from "./registry.ts";
import { CommandError, type CommandResult } from "./types.ts";

let s: Setup | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

const registry = createCommandRegistry();

async function start(options: Parameters<typeof setup>[0] & { effortLevels?: string[] } = {}) {
  s = await setup(options);
  if (options.effortLevels !== undefined) {
    s.mock.endpoint.template = { reasoningEffortLevels: options.effortLevels };
  }
  const session = await s.engine.createSession({ cwd: s.project });
  return { s, session };
}

function run(session: SessionRuntime, name: string, args = ""): Promise<CommandResult> {
  if (s === null) throw new Error("no setup");
  return registry.run(name, {
    args,
    session,
    engine: s.engine,
    homeDir: s.home,
    settingsFlags: { allowedTools: ["Bash(npm test *)"] },
    capabilities: {},
    describeEndpoint: () => ({ kind: "remote", url: "http://127.0.0.1:9/v1" }),
  });
}

async function outputOf(session: SessionRuntime, name: string, args = ""): Promise<string> {
  const result = await run(session, name, args);
  if (result.kind !== "output") throw new Error(`expected output, got ${result.kind}`);
  return result.text;
}

async function commandError(promise: Promise<unknown>): Promise<CommandError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  throw new Error("expected a CommandError");
}

describe("registry", () => {
  it("parses typed commands and arguments", () => {
    expect(parseSlashCommand("/compact keep the API notes")).toEqual({
      name: "compact",
      args: "keep the API notes",
    });
    expect(parseSlashCommand("  /HELP  ")).toEqual({ name: "help", args: "" });
    expect(parseSlashCommand("not a command")).toBeNull();
    expect(parseSlashCommand("/ spaced")).toBeNull();
    expect(splitArguments(`"a b" c\\ d 'e'`, "x")).toEqual(["a b", "c d", "e"]);
    expect(() => splitArguments(`"open`, "x")).toThrow(CommandError);
  });

  it("refuses clashing names unless replacing, and finds aliases", () => {
    const r = new CommandRegistry();
    const make = (name: string, aliases: string[] = []) => ({
      name,
      aliases,
      description: name,
      argumentHint: null,
      run: () => ({ kind: "output" as const, text: name }),
    });
    r.register(make("one", ["uno"]));
    expect(() => r.register(make("uno"))).toThrow(/taken/);
    expect(() => r.register(make("one"))).toThrow(/already/);
    r.register(make("one", ["eins"]), { replace: true });
    expect(r.get("EINS")?.name).toBe("one");
    expect(r.get("uno")).toBeUndefined();
    expect(() => r.register(make("Bad Name"))).toThrow(/valid/);
    r.register(make("team:deploy"));
    expect(r.info().map((c) => c.name)).toEqual(["one", "team:deploy"]);
  });

  it("lists every built-in", () => {
    expect(registry.info().map((c) => c.name)).toEqual([
      "add-dir",
      "clear",
      "compact",
      "context",
      "effort",
      "export",
      "help",
      "init",
      "mode",
      "model",
      "permissions",
      "plan",
      "rename",
      "resume",
      "status",
    ]);
  });
});

describe("built-in commands", () => {
  it("/help lists commands and explains one; unknown commands are errors", async () => {
    const { session } = await start();
    const all = await outputOf(session, "help");
    expect(all).toContain("/add-dir <path>");
    expect(all).toContain("/compact [focus]");
    expect(await outputOf(session, "help", "/clear")).toContain("Also: /reset, /new");
    await commandError(run(session, "help", "nothing"));
    const unknown = await commandError(run(session, "nope", "please"));
    expect(unknown.message).toContain("/nope");
  });

  it("/status and /context describe the session", async () => {
    const { s, session } = await start({ script: [text("hi")] });
    const status = await outputOf(session, "status");
    expect(status).toContain(`Session: ${session.id}`);
    expect(status).toContain("Endpoint: remote at http://127.0.0.1:9/v1");
    expect(status).toContain("Mode: default");
    expect(status).toContain(`Working directory: ${s.project}`);
    expect(status).toMatch(/Transcript: .*\.jsonl/);
    await commandError(run(session, "status", "extra"));

    const before = await outputOf(session, "context");
    expect(before).toContain("estimated");
    expect(before).toMatch(/Tool definitions\s+[\d,]+/);
    await session.run(ask("hello"));
    const after = await outputOf(session, "context");
    expect(after).toContain("as counted by the endpoint");
    expect(after).toMatch(/Free\s+[\d,]+/);
  });

  it("/permissions lists rules with their sources", async () => {
    const { s, session } = await start();
    await mkdir(path.join(s.project, ".dawg"), { recursive: true });
    await writeFile(
      path.join(s.project, ".dawg", "settings.json"),
      JSON.stringify({ permissions: { deny: ["Read(./.env)"], ask: ["Bash(git push *)"] } }),
    );
    const out = await outputOf(session, "permissions");
    expect(out).toMatch(
      /Read\(\.\/\.env\)\s+from shared project settings \(\.dawg\/settings\.json\)/,
    );
    expect(out).toMatch(/Bash\(git push \*\)\s+from shared project settings/);
    expect(out).toMatch(/Bash\(npm test \*\)\s+from command line/);
    expect(await outputOf(session, "allowed-tools")).toBe(out);
  });

  it("/mode and /plan change the mode; bad modes are errors", async () => {
    const { session } = await start({ script: [text("planning")] });
    expect(await outputOf(session, "mode")).toContain("Mode: default");
    expect(await outputOf(session, "mode", "accept-edits")).toBe("Mode: acceptEdits.");
    expect(session.mode).toBe("acceptEdits");
    expect(await outputOf(session, "mode", "manual")).toBe("Mode: default.");
    await commandError(run(session, "mode", "sideways"));
    await commandError(run(session, "mode", "plan extra"));
    expect(await outputOf(session, "plan")).toContain("Plan mode");
    expect(session.mode).toBe("plan");
    const started = await run(session, "plan", "fix the auth bug");
    expect(started).toMatchObject({
      kind: "prompt",
      prompt: { content: [{ type: "text", text: "fix the auth bug" }] },
    });
  });

  it("/model and /effort show and change the model's settings", async () => {
    const { session } = await start({ effortLevels: ["low", "high"] });
    const shown = await outputOf(session, "model");
    expect(shown).toContain("Model: mock-model");
    expect(shown).toContain("Context window: 8,192 tokens");
    expect(await outputOf(session, "model", "other-model")).toContain("Model: other-model");
    await commandError(run(session, "model", "a b"));
    expect(await outputOf(session, "effort")).toContain("Levels, weakest first: low, high");
    expect(await outputOf(session, "effort", "HIGH")).toBe("Effort: high.");
    expect(session.effort).toBe("high");
    await commandError(run(session, "effort", "ludicrous"));
    expect(await outputOf(session, "effort", "auto")).toBe("Effort: model default.");
    expect(session.effort).toBeNull();
  });

  it("/effort explains a model without levels", async () => {
    const { session } = await start();
    expect(await outputOf(session, "effort")).toBe("This model has no effort levels.");
    await commandError(run(session, "effort", "high"));
  });

  it("/add-dir adds an existing directory and refuses anything else", async () => {
    const { s, session } = await start();
    const extra = path.join(s.root, "extra dir");
    await mkdir(extra);
    expect(await outputOf(session, "add-dir", `"${extra}"`)).toContain(extra);
    expect(session.additionalDirectories).toEqual([extra]);
    await commandError(run(session, "add-dir", path.join(s.root, "missing")));
    await commandError(run(session, "add-dir"));
  });

  it("/rename renames; an empty name is an error", async () => {
    const { session } = await start();
    expect(await outputOf(session, "rename", "My\tsession\u0007 work")).toBe(
      "Renamed to “My session work”.",
    );
    expect(session.summary().title).toBe("My session work");
    await commandError(run(session, "rename"));
    await commandError(run(session, "rename", "​"));
  });

  it("/export writes Markdown inside the project by default and never overwrites", async () => {
    const { s, session } = await start({ script: [text("Exported reply")] });
    await session.run(ask("export me"));
    const out = await outputOf(session, "export");
    const file = path.join(s.project, `dawg-session-${session.id}.md`);
    expect(out).toBe(`Exported the conversation to dawg-session-${session.id}.md.`);
    const markdown = await readFile(file, "utf8");
    expect(markdown).toContain("export me");
    expect(markdown).toContain("Exported reply");
    await commandError(run(session, "export"));
    expect(await outputOf(session, "export", "notes/chat.md")).toContain("notes/chat.md");
    await commandError(run(session, "export", ".claude/chat.md"));
    await commandError(run(session, "export", "a b"));
  });

  it("/compact starts compaction without holding the request; refuses during a turn", async () => {
    const { s, session } = await start({ script: [text("one")] });
    await session.run(ask("first"));
    expect(await outputOf(session, "compact", "keep the API notes")).toContain(
      "focusing on: keep the API notes",
    );
    expect(session.busy).toBe(true);
    await session.waitForIdle();
    const compactions = (await s.engine.replay(session.id, 0)).events.filter(
      (e) => e.event === "compaction.finished",
    );
    expect(compactions[0]?.payload).toMatchObject({ outcome: "completed" });
    await expect(run(session, "compact")).resolves.toMatchObject({ kind: "output" });
    await expect(run(session, "compact")).rejects.toBeInstanceOf(RuntimeError);
    await session.waitForIdle();
  });

  it("/clear opens a new session and keeps the old one", async () => {
    const { s, session } = await start();
    const result = await run(session, "reset", "Old work");
    if (result.kind !== "session") throw new Error("expected a session");
    expect(result.replaces).toBe(session.id);
    expect(result.session.id).not.toBe(session.id);
    expect(session.closed).toBe(true);
    const listed = await s.engine.listSessions({ projectDir: s.project });
    expect(listed.sessions.find((x) => x.id === session.id)?.title).toBe("Old work");
  });

  it("/resume lists, finds by id or title, and reports what it cannot find", async () => {
    const { s, session } = await start();
    expect(await outputOf(session, "resume")).toBe("No other saved conversations in this project.");
    const other = await s.engine.createSession({ cwd: s.project, title: "Refactor auth" });
    const otherId = other.id;
    await other.close();
    const listing = await outputOf(session, "resume");
    expect(listing).toContain(otherId);
    expect(listing).toContain("Refactor auth");
    const byTitle = await run(session, "resume", "refactor auth");
    expect(byTitle).toMatchObject({ kind: "session", replaces: null });
    if (byTitle.kind === "session") {
      expect(byTitle.session.id).toBe(otherId);
      await byTitle.session.close();
    }
    const byId = await run(session, "continue", otherId);
    expect(byId.kind === "session" && byId.session.id).toBe(otherId);
    await commandError(run(session, "resume", "no such thing"));
    expect(await outputOf(session, "resume", session.id)).toBe("That is the current conversation.");
  });

  it("/init asks the model to write the right instruction file", async () => {
    const { s, session } = await start();
    const result = await run(session, "init", "mention the docs folder");
    if (result.kind !== "prompt") throw new Error("expected a prompt");
    const prompt = JSON.stringify(result.prompt);
    expect(prompt).toContain("Create the instruction file `CLAUDE.md`");
    expect(prompt).toContain("mention the docs folder");
    expect(result.text).toContain("Writing CLAUDE.md");
    expect(s.mock.chatRequests).toHaveLength(0);
  });
});

describe("which file /init writes", () => {
  it("prefers an existing CLAUDE.md, keeps AGENTS.md projects on AGENTS.md, else CLAUDE.md", async () => {
    s = await setup();
    const home = s.home;
    const root = path.join(s.root, "tree");
    const project = path.join(root, "app");
    await mkdir(project, { recursive: true });

    expect(await chooseInstructionFile(project, home)).toMatchObject({
      path: path.join(project, "CLAUDE.md"),
      exists: false,
    });

    await writeFile(path.join(root, "AGENTS.md"), "parent rules");
    expect(await chooseInstructionFile(project, home)).toMatchObject({
      path: path.join(project, "AGENTS.md"),
      exists: false,
    });

    await writeFile(path.join(project, "AGENTS.md"), "rules");
    expect(await chooseInstructionFile(project, home)).toMatchObject({
      path: path.join(project, "AGENTS.md"),
      exists: true,
    });

    // A CLAUDE.md above switches AGENTS.md off, so a new file must be CLAUDE.md.
    await writeFile(path.join(root, "CLAUDE.md"), "parent");
    expect(await chooseInstructionFile(project, home)).toMatchObject({
      path: path.join(project, "CLAUDE.md"),
      exists: false,
    });

    await writeFile(path.join(project, "CLAUDE.md"), "mine");
    expect(await chooseInstructionFile(project, home)).toMatchObject({
      path: path.join(project, "CLAUDE.md"),
      exists: true,
    });
  });
});
