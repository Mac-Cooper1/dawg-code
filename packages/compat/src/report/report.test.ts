/**
 * The report's framework and each provider, against setups written into a temporary folder.
 * Whole setups, as a person would have them, are in the compatibility suite (fixtures.test.ts).
 */
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CompatItem } from "@dawg/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentsProvider } from "./agents.ts";
import { buildCompatReport, compareItems } from "./build.ts";
import { configRoots, displayPath, listFiles, readFrontMatter, rootRank } from "./files.ts";
import { instructionsProvider } from "./instructions.ts";
import { mcpProvider } from "./mcp.ts";
import { otherProvider } from "./other.ts";
import { REPORT_PROVIDERS } from "./providers.ts";
import { settingsProvider } from "./settings.ts";
import { keyGroup } from "./settings-keys.ts";
import type { ReportContext } from "./types.ts";
import { MAX_WALK_DEPTH, projectSubdirectories } from "./walk.ts";

let root: string;
let home: string;
let project: string;
let context: ReportContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dawg-compat-report-"));
  home = join(root, "home");
  project = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  context = { homeDir: home, projectDir: project };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const brief = (items: readonly CompatItem[]) =>
  items.map(
    (item) => `${item.kind} ${item.name} ${item.source.scope}/${item.source.origin} ${item.status}`,
  );

describe("buildCompatReport", () => {
  it("lists items by kind, then scope, then name, the same every time", async () => {
    await put(join(project, ".claude", "agents", "b.md"), "---\nname: b\ndescription: B\n---\n");
    await put(join(home, ".claude", "agents", "z.md"), "---\nname: z\ndescription: Z\n---\n");
    await put(join(project, ".claude", "agents", "a.md"), "---\nname: a\ndescription: A\n---\n");
    await put(join(project, "CLAUDE.md"), "# P\n");
    await put(join(home, ".claude", "CLAUDE.md"), "# H\n");
    await put(join(project, ".claude", "settings.json"), "{}");
    const first = await buildCompatReport(context);
    expect(brief(first.items)).toEqual([
      "instructions ~/.claude/CLAUDE.md user/claude loaded",
      "instructions CLAUDE.md project/claude loaded",
      "settings .claude/settings.json project/claude loaded",
      "agent z user/claude loaded",
      "agent a project/claude loaded",
      "agent b project/claude loaded",
    ]);
    expect(await buildCompatReport(context)).toEqual(first);
    expect([...first.items].reverse().sort(compareItems)).toEqual(first.items);
  });

  it("lists a file found twice once, with the notes of both", async () => {
    await put(join(project, "CLAUDE.md"), "@shared.md\n");
    await put(join(project, ".claude", "rules", "x.md"), "@../../shared.md\n");
    await put(join(project, "shared.md"), "Shared.\n");
    const report = await buildCompatReport(context);
    const shared = report.items.filter((item) => item.name === "shared.md");
    expect(shared).toHaveLength(1);
    expect(shared[0]?.notes).toEqual(["Imported by CLAUDE.md.", "Imported by .claude/rules/x.md."]);
  });

  it("never throws: a provider that fails becomes an invalid item", async () => {
    REPORT_PROVIDERS.push(async () => {
      throw new Error("disk on fire");
    });
    try {
      const report = await buildCompatReport(context);
      expect(report.items).toEqual([
        {
          kind: "other",
          name: "Part of the report",
          source: { path: project, origin: "dawg", scope: "project" },
          status: "invalid",
          notes: ["Could not finish this part of the report: disk on fire."],
        },
      ]);
    } finally {
      REPORT_PROVIDERS.pop();
    }
  });

  it("repairs items without a name and drops empty notes", async () => {
    REPORT_PROVIDERS.push(async () => [
      {
        kind: "skill",
        name: " ",
        source: { path: join(project, "x", "SKILL.md"), origin: "claude", scope: "project" },
        status: "loaded",
        notes: ["", "Fine."],
      },
    ]);
    try {
      const report = await buildCompatReport(context);
      expect(report.items).toEqual([
        expect.objectContaining({ name: "SKILL.md", notes: ["Fine."] }),
      ]);
    } finally {
      REPORT_PROVIDERS.pop();
    }
  });

  it("without a project, lists only the person's own setup", async () => {
    await put(join(home, ".claude", "CLAUDE.md"), "# Mine\n");
    await put(join(home, ".claude", "settings.json"), "{}");
    await put(join(project, "CLAUDE.md"), "# Theirs\n");
    await put(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { a: { command: "a" } } }));
    const report = await buildCompatReport({ homeDir: home, projectDir: null });
    expect(report.projectDir).toBeNull();
    expect(brief(report.items)).toEqual([
      "instructions ~/.claude/CLAUDE.md user/claude loaded",
      "settings ~/.claude/settings.json user/claude loaded",
    ]);
  });

  it("lists the home folder's files once when the project is the home folder", async () => {
    await put(join(home, ".claude", "agents", "a.md"), "---\nname: a\ndescription: A\n---\n");
    await put(join(home, ".claude", "settings.json"), "{}");
    const report = await buildCompatReport({ homeDir: home, projectDir: home });
    expect(brief(report.items)).toEqual([
      "settings ~/.claude/settings.json user/claude loaded",
      "agent a user/claude loaded",
    ]);
  });
});

describe("files", () => {
  it("names paths from the project, else from home", () => {
    expect(displayPath(join(project, ".claude", "x.md"), context)).toBe(".claude/x.md");
    expect(displayPath(join(home, ".claude", "x.md"), context)).toBe("~/.claude/x.md");
    expect(displayPath("/etc/hosts", context)).toBe("/etc/hosts");
  });

  it("ranks the project over the person, and .dawg over .claude", () => {
    const ranks = configRoots(context).map(rootRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(4);
    expect(rootRank({ scope: "local", origin: "claude" })).toBeGreaterThan(
      rootRank({ scope: "project", origin: "dawg" }),
    );
  });

  it("lists files in a stable order, follows links once, and skips hidden folders", async () => {
    const dir = join(root, "list");
    await put(join(dir, "b.md"), "");
    await put(join(dir, "a", "c.md"), "");
    await put(join(dir, ".hidden", "d.md"), "");
    await put(join(dir, "e.txt"), "");
    await symlink(dir, join(dir, "a", "loop"));
    expect((await listFiles(dir, ".md")).map((p) => p.slice(dir.length + 1))).toEqual([
      "a/c.md",
      "b.md",
    ]);
    expect(
      (await listFiles(dir, ".md", { recursive: false })).map((p) => p.slice(dir.length + 1)),
    ).toEqual(["b.md"]);
  });

  it("reads front matter, none, and front matter that is not a mapping", async () => {
    const path = join(root, "f.md");
    await put(path, "---\nname: x\n---\nbody\n");
    expect(await readFrontMatter(path)).toEqual({
      kind: "ok",
      fields: { name: "x" },
      body: "body\n",
    });
    await put(path, "no front matter\n");
    expect(await readFrontMatter(path)).toMatchObject({ kind: "ok", fields: null });
    await put(path, "---\n- a\n- b\n---\n");
    expect(await readFrontMatter(path)).toMatchObject({ kind: "invalid" });
    expect(await readFrontMatter(join(root, "missing.md"))).toEqual({ kind: "missing" });
  });
});

describe("instructions", () => {
  it("reports a file it cannot read as invalid", async () => {
    const path = join(project, "CLAUDE.md");
    await put(path, "# P\n");
    await chmod(path, 0o000);
    try {
      const items = await instructionsProvider(context);
      // Running as root can read anything; the check only means something otherwise.
      if (process.getuid?.() !== 0) {
        expect(items).toEqual([
          expect.objectContaining({
            name: "CLAUDE.md",
            status: "invalid",
            notes: [expect.any(String)],
          }),
        ]);
      }
    } finally {
      await chmod(path, 0o644);
    }
  });

  it("marks a file whose import was skipped as partly supported", async () => {
    await put(join(project, "CLAUDE.md"), "@~/outside.md\n@a.md\n");
    await put(join(home, "outside.md"), "Outside.\n");
    await put(join(project, "a.md"), "@CLAUDE.md\n");
    const items = await instructionsProvider(context);
    const top = items.find((item) => item.name === "CLAUDE.md");
    expect(top?.status).toBe("partly-supported");
    expect(top?.notes.join(" ")).toMatch(/outside the project|external/i);
    expect(top?.notes.join(" ")).toContain("import itself");
  });

  it("keeps a file whose import cannot be read, partly supported rather than invalid", async () => {
    await put(join(project, "CLAUDE.md"), "@secret.md\n");
    const secret = join(project, "secret.md");
    await put(secret, "Hidden.\n");
    await chmod(secret, 0o000);
    try {
      if (process.getuid?.() === 0) return;
      const items = await instructionsProvider(context);
      expect(items.find((item) => item.name === "CLAUDE.md")).toMatchObject({
        status: "partly-supported",
        notes: [expect.stringContaining("Import @secret.md skipped")],
      });
    } finally {
      await chmod(secret, 0o644);
    }
  });

  it("lists AGENTS.md only when no CLAUDE.md applies", async () => {
    await put(join(project, "AGENTS.md"), "Agents.\n");
    await put(join(project, "CLAUDE.md"), "Claude.\n");
    await put(join(project, "lib", "AGENTS.md"), "Lib.\n");
    expect((await instructionsProvider(context)).map((item) => item.name)).toEqual(["CLAUDE.md"]);
  });

  it("does not walk deeper than its limit", async () => {
    const deep = Array.from({ length: MAX_WALK_DEPTH + 2 }, (_, i) => `d${i}`);
    await put(join(project, ...deep, "CLAUDE.md"), "Deep.\n");
    await put(join(project, ...deep.slice(0, 2), "CLAUDE.md"), "Shallow.\n");
    const names = (await instructionsProvider(context)).map((item) => item.name);
    expect(names).toEqual(["d0/d1/CLAUDE.md"]);
    const dirs = await projectSubdirectories(context);
    expect(dirs).toHaveLength(MAX_WALK_DEPTH);
  });
});

describe("settings", () => {
  it("groups keys dawg ignores by why", () => {
    expect(keyGroup("theme")).toBe("unused");
    expect(keyGroup("permissions.blockReadsOutsideWorkingDirectories")).toBe("unused");
    expect(keyGroup("apiKeyHelper")).toBe("cloud");
    expect(keyGroup("model")).toBe("model");
    expect(keyGroup("sandbox")).toBe("own-item");
    expect(keyGroup("hooks")).toBe("own-item");
    expect(keyGroup("statusLine")).toBe("own-item");
    expect(keyGroup("env.ANTHROPIC_BASE_URL")).toBe("hosted-env");
  });

  it("loads an empty file and dawg's own Anthropic variables", async () => {
    await put(join(project, ".claude", "settings.json"), "");
    await put(
      join(home, ".dawg", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://localhost:1" }, hooks: {} }),
    );
    expect(brief(await settingsProvider(context))).toEqual([
      "settings .claude/settings.json project/claude loaded",
      "settings ~/.dawg/settings.json user/dawg loaded",
    ]);
  });

  it("names a value it rejects", async () => {
    await put(
      join(project, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: "Read", defaultMode: "turbo" } }),
    );
    const [item] = await settingsProvider(context);
    expect(item?.status).toBe("partly-supported");
    expect(item?.notes).toEqual([
      "permissions.allow: Expected a list of strings, found a string.",
      'permissions.defaultMode: Permission mode "turbo" is not supported; ignored.',
    ]);
  });
});

describe("agents", () => {
  it("lets the project's definition win over the person's", async () => {
    await put(join(home, ".dawg", "agents", "x.md"), "---\nname: x\ndescription: Mine\n---\n");
    await put(
      join(project, ".claude", "agents", "x.md"),
      "---\nname: x\ndescription: Theirs\n---\n",
    );
    const items = await agentsProvider(context);
    expect(items.map((item) => [item.source.scope, item.notes])).toEqual([
      ["user", ["Not used: .claude/agents/x.md defines “x” too and takes its place."]],
      ["project", []],
    ]);
  });
});

describe("mcp", () => {
  it("describes each transport, and refuses what is not a definition", async () => {
    await put(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          ws: { type: "ws", url: "wss://user:pass@mcp.example.com/socket?token=1" },
          sdk: { type: "sdk" },
          odd: { type: "carrier-pigeon" },
          text: "npx server",
          nourl: { type: "http" },
          long: { command: "server", args: ["--flag", "a value with spaces", "x".repeat(300)] },
        },
      }),
    );
    const items = await mcpProvider(context);
    const byName = Object.fromEntries(items.map((item) => [item.name, item]));
    expect(byName.ws?.notes[0]).toBe("Connects to wss://mcp.example.com/socket over WebSocket.");
    expect(byName.sdk?.status).toBe("not-supported");
    expect(byName.sdk?.notes[0]).toContain("embeds Claude Code");
    expect(byName.odd).toMatchObject({
      status: "invalid",
      notes: ["Unknown server type “carrier-pigeon”."],
    });
    expect(byName.text).toMatchObject({ status: "invalid" });
    expect(byName.nourl).toMatchObject({
      status: "invalid",
      notes: ["A http server needs a url."],
    });
    expect(byName.long?.notes[0]).toMatch(
      /^Runs a local command: server --flag "a value with spaces" x+…\.$/,
    );
    expect(byName.long?.notes[0]?.length).toBeLessThan(200);
  });

  it("matches ~/.claude.json's project entry through a symbolic link", async () => {
    const link = join(root, "link");
    await symlink(project, link);
    await put(
      join(home, ".claude.json"),
      JSON.stringify({
        projects: { [await realpath(project)]: { mcpServers: { s: { command: "s" } } } },
      }),
    );
    const items = await mcpProvider({ homeDir: home, projectDir: link });
    expect(brief(items)).toEqual(["mcp-server s local/claude not-supported"]);
  });
});

describe("other", () => {
  it("finds Claude Code's auto memory for the project", async () => {
    const key = project.replace(/[^A-Za-z0-9]/g, "-");
    await put(join(home, ".claude", "projects", key, "memory", "MEMORY.md"), "- notes\n");
    expect(brief(await otherProvider(context))).toEqual([
      "other Claude Code's auto memory for this project user/claude not-supported",
    ]);
  });

  it("lets a project's output style win over the person's of the same name", async () => {
    await put(join(home, ".claude", "output-styles", "review.md"), "Mine.\n");
    await put(join(project, ".claude", "output-styles", "review.md"), "Theirs.\n");
    const items = await otherProvider(context);
    expect(items.map((item) => item.notes.at(-1))).toEqual([
      "Not used: .claude/output-styles/review.md defines “Output style: review” too and takes its place.",
      "Output styles arrive in Phase 5.",
    ]);
  });
});
