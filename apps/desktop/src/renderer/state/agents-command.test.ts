/**
 * `/agents` typed in the composer opens Settings → Subagents (the engine's command only lists,
 * for clients without Settings), and the page's requests reach the engine.
 */
import type { CommandInfo } from "@dawg/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeBridge, type FakeBridge } from "./__fixtures__/fake-bridge.ts";
import { FakeEngine } from "./__fixtures__/fake-engine.ts";
import { PROJECT } from "./__fixtures__/streams.ts";
import { type AppStoreApi, createAppStore } from "./store.ts";

const ID = "s1";

const COMMANDS: CommandInfo[] = [
  { name: "help", description: "Show help", argumentHint: null },
  { name: "agents", description: "Show the subagents", argumentHint: null },
];

const harnesses: { store: AppStoreApi; bridge: FakeBridge }[] = [];

afterEach(() => {
  for (const { store, bridge } of harnesses.splice(0)) {
    store.getState().actions.stop();
    bridge.close();
  }
});

async function started() {
  const engine = new FakeEngine();
  engine.addSession(
    ID,
    { title: "Fix the split", projectDir: PROJECT, cwd: PROJECT },
    { commands: COMMANDS },
  );
  const bridge = createFakeBridge({ engine, windowState: { selectedSessionId: ID } });
  const store = createAppStore({ bridge });
  harnesses.push({ store, bridge });
  await store.getState().actions.start();
  await vi.waitFor(() => expect(store.getState().sessions[ID]?.loaded).toBe(true));
  return { engine, bridge, store };
}

describe("/agents", () => {
  it("opens Settings → Subagents instead of asking the engine", async () => {
    const { store, engine } = await started();
    store.getState().actions.setDraft(ID, "/agents");
    await store.getState().actions.submit(ID, "/agents");
    expect(store.getState().layout).toMatchObject({ view: "settings", settingsPage: "subagents" });
    expect(engine.callsOf("session.command")).toEqual([]);
    expect(engine.callsOf("session.prompt")).toEqual([]);
    expect(store.getState().ui.drafts[ID]).toBeUndefined();
  });

  it("with arguments, goes to the engine like any command", async () => {
    const { store, engine } = await started();
    await store.getState().actions.submit(ID, "/agents all");
    expect(engine.callsOf("session.command")).toEqual([
      { sessionId: ID, name: "agents", args: "all" },
    ]);
    expect(store.getState().layout.view).toBe("sessions");
  });
});

describe("Settings → Subagents' requests", () => {
  it("lists the agents and writes a new file", async () => {
    const { store, engine } = await started();
    const listing = await store.getState().actions.listSubagents(PROJECT);
    expect(listing).toMatchObject({
      projectDir: PROJECT,
      folders: { project: `${PROJECT}/.dawg/agents` },
    });
    const made = await store.getState().actions.createSubagent({
      projectDir: PROJECT,
      scope: "project",
      name: "checker",
      description: "Checks things",
      prompt: "",
      tools: ["Read"],
      memory: "local",
    });
    expect(made).toMatchObject({ path: `${PROJECT}/.dawg/agents/checker.md` });
    expect(engine.callsOf("subagent.create")).toEqual([
      {
        projectDir: PROJECT,
        scope: "project",
        name: "checker",
        description: "Checks things",
        prompt: "",
        tools: ["Read"],
        memory: "local",
      },
    ]);
  });

  it("gives the engine's sentence back when writing fails", async () => {
    const { store, engine } = await started();
    engine.overrides["subagent.create"] = () => {
      throw new Error("~/.dawg/agents/checker.md already exists");
    };
    const made = await store.getState().actions.createSubagent({
      projectDir: PROJECT,
      scope: "user",
      name: "checker",
      description: "Checks things",
      prompt: "",
      tools: null,
      memory: null,
    });
    expect(made).toEqual({ error: "~/.dawg/agents/checker.md already exists." });
  });
});
