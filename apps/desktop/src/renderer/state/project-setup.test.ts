/**
 * The first-open notice: a project with a Claude Code setup is told about once, with a link to
 * Settings → Project setup, and remembered in the desktop settings.
 */
import type { CompatItem, CompatReport } from "@dawg/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettings } from "../../shared/bridge.ts";
import { createFakeBridge, type FakeBridge } from "./__fixtures__/fake-bridge.ts";
import { FakeEngine } from "./__fixtures__/fake-engine.ts";
import { PROJECT } from "./__fixtures__/streams.ts";
import { projectSetupNoticeText, projectSetupSummary } from "./project-setup.ts";
import { type AppStoreApi, createAppStore } from "./store.ts";

function item(
  kind: CompatItem["kind"],
  name: string,
  scope: CompatItem["source"]["scope"] = "project",
  origin: CompatItem["source"]["origin"] = "claude",
): CompatItem {
  return {
    kind,
    name,
    source: { path: `${PROJECT}/.claude/${name}`, origin, scope },
    status: "loaded",
    notes: [],
  };
}

const SETUP: CompatItem[] = [
  item("instructions", "CLAUDE.md"),
  item("instructions", "~/.claude/CLAUDE.md", "user"),
  item("settings", ".claude/settings.json"),
  item("skill", "review"),
  item("skill", "deploy"),
  item("skill", "triage", "local"),
  item("hook", "PreToolUse on Bash: a"),
  item("hook", "Stop: b"),
  item("mcp-server", "db"),
  // Not the project's Claude Code setup: the person's own files, and dawg's.
  item("mcp-server", "github", "user"),
  item("agent", "planner", "project", "dawg"),
];

const report = (items: CompatItem[]): CompatReport => ({
  projectDir: PROJECT,
  items,
  approval: null,
});

describe("projectSetupSummary", () => {
  it("counts what the project's own Claude Code files hold, by kind", () => {
    expect(projectSetupSummary(report(SETUP))).toBe(
      "3 skills, 2 hooks, 1 MCP server, 1 settings file",
    );
    expect(projectSetupNoticeText("tally", "3 skills, 2 hooks, 1 MCP server")).toBe(
      "dawg found a Claude Code setup in tally: 3 skills, 2 hooks, 1 MCP server.",
    );
  });

  it("finds nothing to tell for instruction files alone, or only the person's files", () => {
    expect(projectSetupSummary(report([]))).toBeNull();
    expect(projectSetupSummary(report([item("instructions", "CLAUDE.md")]))).toBeNull();
    expect(projectSetupSummary(report([item("skill", "mine", "user")]))).toBeNull();
    expect(projectSetupSummary(report([item("skill", "ours", "project", "dawg")]))).toBeNull();
  });
});

describe("the first-open notice", () => {
  const running: { store: AppStoreApi; bridge: FakeBridge }[] = [];
  afterEach(() => {
    for (const { store, bridge } of running.splice(0)) {
      store.getState().actions.stop();
      bridge.close();
    }
  });

  async function start(engine: FakeEngine, settings: Partial<DesktopSettings> = {}) {
    const bridge = createFakeBridge({ engine, windowState: { selectedSessionId: "s1" }, settings });
    const store = createAppStore({ bridge });
    running.push({ store, bridge });
    await store.getState().actions.start();
    return { store, bridge };
  }

  function engineWith(items: CompatItem[]): FakeEngine {
    const engine = new FakeEngine();
    engine.addSession("s1", { projectDir: PROJECT, cwd: PROJECT });
    engine.overrides["project.inspect"] = (params) => ({
      projectDir: params.projectDir,
      items,
      approval: null,
    });
    return engine;
  }

  it("tells about a project's setup once, links to Project setup, and remembers it", async () => {
    const engine = engineWith(SETUP);
    const { store, bridge } = await start(engine);
    await vi.waitFor(() =>
      expect(store.getState().notices.map((n) => n.text)).toContain(
        "dawg found a Claude Code setup in tally: 3 skills, 2 hooks, 1 MCP server, 1 settings file.",
      ),
    );
    const notice = store.getState().notices.find((n) => n.action !== undefined);
    expect(notice).toMatchObject({ tone: "neutral", action: { label: "See what it uses" } });
    await vi.waitFor(async () =>
      expect((await bridge.settings.get()).projectSetupNoticed).toEqual([PROJECT]),
    );
    expect(engine.callsOf("project.inspect")).toContainEqual({ projectDir: PROJECT });

    notice?.action?.run();
    expect(store.getState().layout).toMatchObject({ view: "settings", settingsPage: "setup" });
  });

  it("does not tell again once remembered", async () => {
    const engine = engineWith(SETUP);
    const { store } = await start(engine, { projectSetupNoticed: [PROJECT] });
    await vi.waitFor(() => expect(store.getState().connection.phase).toBe("ready"));
    // Give a late notice every chance to arrive.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.getState().notices.filter((n) => n.action)).toEqual([]);
  });

  it("says nothing for a project without a Claude Code setup, or when the engine cannot tell", async () => {
    const plain = engineWith([item("instructions", "CLAUDE.md")]);
    const first = await start(plain);
    await vi.waitFor(() => expect(plain.callsOf("project.inspect").length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(first.store.getState().notices.filter((n) => n.action)).toEqual([]);
    expect((await first.bridge.settings.get()).projectSetupNoticed).toEqual([]);

    const failing = engineWith([]);
    failing.overrides["project.inspect"] = () => {
      throw new Error("not today");
    };
    const second = await start(failing);
    await vi.waitFor(() => expect(failing.callsOf("project.inspect").length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A failed inspection is not the person's problem: no error notice either.
    expect(second.store.getState().notices.filter((n) => n.text.includes("not today"))).toEqual([]);
  });
});
