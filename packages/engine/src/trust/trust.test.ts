/**
 * The trust store (Phase 4 spec, principle 3): what needs consent, the hash it is kept under, a
 * stale hash refused, and every compatibility fixture's `expected.approval`.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { COMPAT_FIXTURES, materialiseFixture } from "@dawg/compat";
import { CodeApprovalSchema, type CompatItem } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { withApproval } from "./report.ts";
import { createTrustStore, TRUST_FILE } from "./store.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "dawg-trust-"));
  roots.push(root);
  return root;
}

async function setup(files: Record<string, unknown> = {}) {
  const root = await tempRoot();
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const store = path.join(root, "store");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  const write = async (rel: string, content: unknown) => {
    const file = path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
    return file;
  };
  for (const [rel, content] of Object.entries(files)) await write(rel, content);
  return {
    root,
    home,
    project,
    store,
    write,
    trust: createTrustStore({ storeRoot: store, homeDir: home }),
  };
}

const hook = (event: string, command: string, matcher?: string) => ({
  hooks: {
    [event]: [
      { ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command }] },
    ],
  },
});

describe("the compatibility fixtures' consent", () => {
  it.each(Object.entries(COMPAT_FIXTURES))("%s", async (_name, fixture) => {
    const root = await tempRoot();
    const { homeDir, projectDir } = await materialiseFixture(fixture, root);
    const trust = createTrustStore({ storeRoot: path.join(root, "store"), homeDir });
    const approval = await trust.approval(projectDir);
    if (fixture.expected.approval === null) {
      expect(approval).toBeNull();
      return;
    }
    expect(approval).not.toBeNull();
    expect(CodeApprovalSchema.parse(approval)).toEqual(approval);
    expect(approval?.approved).toBe(false);
    expect(approval?.items).toHaveLength(fixture.expected.approval.items);
    expect(approval?.items.every((item) => item.status === "needs-approval")).toBe(true);
    // Approving covers all of it, and every source may then run.
    await trust.decide(projectDir, approval?.hash ?? "", true);
    const after = await trust.approval(projectDir);
    expect(after?.approved).toBe(true);
    expect(after?.items.every((item) => item.status === "loaded")).toBe(true);
    for (const item of approval?.items ?? []) {
      expect(await trust.allows(item.source, projectDir)).toBe(true);
    }
  });
});

describe("the trust store", () => {
  it("lists project hooks and Claude Code's user hooks, not the person's dawg hooks", async () => {
    const s = await setup({
      "project/.claude/settings.json": hook("PreToolUse", "./check.sh", "Bash"),
      "project/.dawg/settings.local.json": hook("Stop", "./notify.sh"),
      "home/.claude/settings.json": hook("PostToolUse", "npm run lint", "Edit|Write"),
      "home/.dawg/settings.json": hook("SessionStart", "git status"),
    });
    const approval = await s.trust.approval(s.project);
    expect(approval?.items.map((i) => [i.name, i.source.scope, i.source.origin])).toEqual([
      ["Stop: ./notify.sh", "local", "dawg"],
      ["PreToolUse on Bash: ./check.sh", "project", "claude"],
      ["PostToolUse on Edit|Write: npm run lint", "user", "claude"],
    ]);
    expect(approval?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      await s.trust.allows(
        { path: path.join(s.home, ".dawg", "settings.json"), origin: "dawg", scope: "user" },
        s.project,
      ),
    ).toBe(true);
    // Without a project, only the person's own files count.
    expect((await s.trust.approval(null))?.items.map((i) => i.name)).toEqual([
      "PostToolUse on Edit|Write: npm run lint",
    ]);
  });

  it("refuses a hash that no longer matches the definitions on disk", async () => {
    const s = await setup({ "project/.claude/settings.json": hook("Stop", "./a.sh") });
    const shown = await s.trust.approval(s.project);
    await s.write("project/.claude/settings.json", hook("Stop", "./b.sh"));
    await expect(s.trust.decide(s.project, shown?.hash ?? "", true)).rejects.toThrow(/changed/);
    const source = {
      path: path.join(s.project, ".claude", "settings.json"),
      origin: "claude" as const,
      scope: "project" as const,
    };
    expect(await s.trust.allows(source, s.project)).toBe(false);
  });

  it("asks again when a definition changes, not when one is removed", async () => {
    const s = await setup({
      "project/.claude/settings.json": {
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command: "./a.sh" },
                { type: "command", command: "./b.sh" },
              ],
            },
          ],
        },
      },
    });
    const source = {
      path: path.join(s.project, ".claude", "settings.json"),
      origin: "claude" as const,
      scope: "project" as const,
    };
    const first = await s.trust.approval(s.project);
    expect(await s.trust.decide(s.project, first?.hash ?? "", true)).toBe(true);
    expect(await s.trust.allows(source, s.project)).toBe(true);

    await s.write("project/.claude/settings.json", hook("Stop", "./a.sh"));
    expect((await s.trust.approval(s.project))?.approved).toBe(true);
    expect(await s.trust.allows(source, s.project)).toBe(true);

    await s.write("project/.claude/settings.json", hook("Stop", "./a.sh --loud"));
    const changed = await s.trust.approval(s.project);
    expect(changed?.approved).toBe(false);
    expect(changed?.hash).not.toBe(first?.hash);
    expect(await s.trust.allows(source, s.project)).toBe(false);
  });

  it("approves Claude Code's user hooks once for every project", async () => {
    const s = await setup({ "home/.claude/settings.json": hook("Stop", "say done") });
    const other = path.join(s.root, "other");
    await mkdir(other);
    const source = {
      path: path.join(s.home, ".claude", "settings.json"),
      origin: "claude" as const,
      scope: "user" as const,
    };
    expect(await s.trust.allows(source, s.project)).toBe(false);
    const approval = await s.trust.approval(s.project);
    await s.trust.decide(s.project, approval?.hash ?? "", true);
    expect(await s.trust.allows(source, other)).toBe(true);
    expect(await s.trust.approval(other)).toMatchObject({ approved: true });
  });

  it("keeps consent per project, under a hash a worktree of it shares", async () => {
    const s = await setup({ "project/.claude/settings.json": hook("Stop", "./a.sh") });
    const worktree = path.join(s.root, "worktree");
    await s.write("worktree/.claude/settings.json", hook("Stop", "./a.sh"));
    const approval = await s.trust.approval(s.project);
    await s.trust.decide(s.project, approval?.hash ?? "", true);
    // A worktree session belongs to the project; its shared files are the project's.
    const source = {
      path: path.join(worktree, ".claude", "settings.json"),
      origin: "claude" as const,
      scope: "project" as const,
    };
    expect(await s.trust.allows(source, s.project)).toBe(true);
    // Another folder with the same files is another project.
    expect(await s.trust.allows(source, worktree)).toBe(false);
  });

  it("takes consent back", async () => {
    const s = await setup({ "project/.claude/settings.json": hook("Stop", "./a.sh") });
    const approval = await s.trust.approval(s.project);
    await s.trust.decide(s.project, approval?.hash ?? "", true);
    expect(await s.trust.decide(s.project, approval?.hash ?? "", false)).toBe(false);
    expect((await s.trust.approval(s.project))?.approved).toBe(false);
  });

  it("counts project skills and commands that run shell commands or allow tools", async () => {
    const s = await setup({
      "project/.claude/commands/deploy.md":
        "---\ndescription: Deploy\n---\nStatus: !`git status --short`\n",
      "project/.claude/commands/plain.md": "Explain the code.\n",
      "home/.claude/commands/mine.md": "Run !`date`\n",
    });
    const approval = await s.trust.approval(s.project);
    expect(approval?.items.map((i) => [i.kind, i.name])).toEqual([["command", "/deploy"]]);
    expect(approval?.items[0]?.notes[0]).toContain("git status --short");
    const source = {
      path: path.join(s.project, ".claude", "commands", "deploy.md"),
      origin: "claude" as const,
      scope: "project" as const,
    };
    expect(await s.trust.allows(source, s.project)).toBe(false);
    await s.trust.decide(s.project, approval?.hash ?? "", true);
    expect(await s.trust.allows(source, s.project)).toBe(true);
    // Rewording the prose does not ask again; changing the command does.
    await s.write(
      "project/.claude/commands/deploy.md",
      "---\ndescription: Ship it\n---\nNow: !`git status --short`\n",
    );
    expect(await s.trust.allows(source, s.project)).toBe(true);
    await s.write("project/.claude/commands/deploy.md", "Now: !`git push`\n");
    expect(await s.trust.allows(source, s.project)).toBe(false);
  });

  it("keeps everything in <storeRoot>/trust.json, and reads a damaged file as nothing approved", async () => {
    const s = await setup({ "project/.claude/settings.json": hook("Stop", "./a.sh") });
    const approval = await s.trust.approval(s.project);
    await s.trust.decide(s.project, approval?.hash ?? "", true);
    const saved = JSON.parse(await readFile(path.join(s.store, TRUST_FILE), "utf8"));
    expect(Object.keys(saved.projects)).toEqual([s.project]);
    await writeFile(path.join(s.store, TRUST_FILE), "{ half");
    expect((await s.trust.approval(s.project))?.approved).toBe(false);
  });

  it("keeps the person's switches, per project for its hooks and everywhere for their own", async () => {
    const s = await setup();
    const other = path.join(s.root, "other");
    await s.trust.switches.set({
      projectDir: s.project,
      id: "p",
      scope: "project",
      enabled: false,
    });
    await s.trust.switches.set({ projectDir: s.project, id: "u", scope: "user", enabled: false });
    expect([...(await s.trust.switches.off(s.project))].sort()).toEqual(["p", "u"]);
    expect([...(await s.trust.switches.off(other))]).toEqual(["u"]);
    await s.trust.switches.set({ projectDir: s.project, id: "p", scope: "project", enabled: true });
    expect([...(await s.trust.switches.off(s.project))]).toEqual(["u"]);
  });
});

describe("the report with consent applied", () => {
  it("marks what would run and waits as needs-approval, and leaves the rest", () => {
    const source = {
      path: "/p/.claude/settings.json",
      origin: "claude" as const,
      scope: "project" as const,
    };
    const items: CompatItem[] = [
      { kind: "hook", name: "Stop: ./a.sh", source, status: "loaded", notes: [] },
      {
        kind: "hook",
        name: "PreCompact: ./b.sh",
        source,
        status: "not-supported",
        notes: ["later"],
      },
      { kind: "skill", name: "/x", source, status: "loaded", notes: [] },
    ];
    const approval = {
      hash: "sha256:1",
      approved: false,
      items: [
        {
          ...items[0],
          status: "needs-approval",
          notes: ["Runs a command from the project's files."],
        },
        { ...items[1], status: "needs-approval", notes: ["x"] },
      ] as CompatItem[],
    };
    const out = withApproval(items, approval);
    expect(out.map((i) => i.status)).toEqual(["needs-approval", "not-supported", "loaded"]);
    expect(out[0]?.notes[0]).toBe(
      "Runs a command from the project's files, so it waits for your approval.",
    );
    expect(withApproval(items, { ...approval, approved: true })).toEqual(items);
  });
});

describe("hosts a project's settings open to the sandbox", () => {
  const hosts = (...allowedDomains: string[]) => ({ sandbox: { network: { allowedDomains } } });

  it("need consent one by one; the person's own do not", async () => {
    const s = await setup({
      "project/.claude/settings.json": hosts("registry.npmjs.org"),
      "home/.claude/settings.json": hosts("github.com"),
      "home/.dawg/settings.json": hosts("example.com"),
    });
    const source = {
      path: path.join(s.project, ".claude", "settings.json"),
      origin: "claude" as const,
      scope: "project" as const,
    };
    const first = await s.trust.approval(s.project);
    expect(first?.items.map((i) => i.name)).toEqual([
      "Network access to registry.npmjs.org (sandbox)",
    ]);
    expect(await s.trust.allows(source, s.project)).toBe(false);
    await s.trust.decide(s.project, first?.hash ?? "", true);
    expect(await s.trust.allows(source, s.project)).toBe(true);
    // Removing a host asks nothing; adding one asks again, for it alone.
    await s.write("project/.claude/settings.json", hosts());
    expect((await s.trust.approval(s.project)) ?? null).toBeNull();
    await s.write("project/.claude/settings.json", hosts("registry.npmjs.org", "evil.example"));
    const again = await s.trust.approval(s.project);
    expect(again?.approved).toBe(false);
    expect(again?.items.map((i) => [i.name, i.status])).toEqual([
      ["Network access to registry.npmjs.org (sandbox)", "loaded"],
      ["Network access to evil.example (sandbox)", "needs-approval"],
    ]);
    expect(await s.trust.allows(source, s.project)).toBe(false);
  });
});
