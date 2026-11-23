/**
 * The store against the real mock engine (`src/mock-engine`) over message ports, playing every
 * built-in scenario instantly. Skipped, with a name that says so, while the mock engine is a stub.
 */
import { createMessagePortTransport, type MessagePortLike } from "@dawg/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_SCENARIOS, createMockEngine, type MockEngine } from "../../mock-engine/index.ts";
import { createFakeBridge, type FakeBridge } from "./__fixtures__/fake-bridge.ts";
import { transcriptProblems } from "./__fixtures__/invariants.ts";
import { HOME } from "./__fixtures__/streams.ts";
import { RESTART_NOTICE } from "./connection.ts";
import { selectSidebar } from "./selectors.ts";
import { type AppStoreApi, createAppStore } from "./store.ts";

function newEngine(): MockEngine | null {
  try {
    return createMockEngine({ homeDir: HOME, speed: Number.POSITIVE_INFINITY });
  } catch {
    return null;
  }
}

const probe = newEngine();
probe?.dispose();
const built = probe !== null;
const name = (text: string) =>
  built ? text : `${text} (skipped: src/mock-engine is still a stub that throws)`;

const engines: MockEngine[] = [];
let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
  for (const engine of engines.splice(0)) engine.dispose();
});

/** A bridge whose ports are served by the current mock engine; `swap` replaces it. */
function setup(): { store: AppStoreApi; bridge: FakeBridge; swap(): void } {
  let current = newEngine() as MockEngine;
  engines.push(current);
  const bridge = createFakeBridge({
    engine: {
      serve: (port) => {
        current.connect(createMessagePortTransport(port as unknown as MessagePortLike));
      },
    },
  });
  const store = createAppStore({ bridge });
  teardown = () => {
    store.getState().actions.stop();
    bridge.close();
  };
  return {
    store,
    bridge,
    swap() {
      current.dispose();
      current = newEngine() as MockEngine;
      engines.push(current);
    },
  };
}

describe("with the mock engine", () => {
  it.skipIf(!built)(
    name("lists and replays every built-in session into consistent transcripts"),
    async () => {
      const { store } = setup();
      await store.getState().actions.start();
      const state = () => store.getState();
      expect(state().connection.phase).toBe("ready");
      expect(Object.keys(state().sessions).length).toBe(BUILT_IN_SCENARIOS.length);
      for (const id of Object.keys(state().sessions)) {
        state().actions.selectSession(id);
        await vi.waitFor(() => expect(state().sessions[id]?.loaded).toBe(true));
      }
      // Let instant live playback land.
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const id of Object.keys(state().sessions)) {
        expect(transcriptProblems(state(), id)).toEqual([]);
      }
      const rows = selectSidebar(state(), Date.now()).flatMap((group) => group.rows);
      expect(rows.length).toBe(BUILT_IN_SCENARIOS.length);
      for (const row of rows) expect(row.markLabel).not.toBe("");
    },
  );

  it.skipIf(!built)(name("sends a prompt to an idle session and shows the turn"), async () => {
    const { store } = setup();
    await store.getState().actions.start();
    const state = () => store.getState();
    const idle = Object.values(state().sessions).find(
      (session) => session.status === "idle" && (state().pending[session.id]?.length ?? 0) === 0,
    );
    if (!idle) return;
    state().actions.selectSession(idle.id);
    await vi.waitFor(() => expect(state().sessions[idle.id]?.loaded).toBe(true));
    await state().actions.submit(idle.id, "Hello from the test");
    await vi.waitFor(() => {
      const user = state().transcripts[idle.id]?.find(
        (item) => item.kind === "user" && item.text === "Hello from the test",
      );
      expect(user).toBeDefined();
    });
  });

  it.skipIf(!built)(name("survives an engine restart from scratch"), async () => {
    const { store, bridge, swap } = setup();
    await store.getState().actions.start();
    const state = () => store.getState();
    for (const id of Object.keys(state().sessions)) {
      state().actions.selectSession(id);
      await vi.waitFor(() => expect(state().sessions[id]?.loaded).toBe(true));
    }
    bridge.restartEngine("The engine host exited (code 1)", swap);
    await vi.waitFor(() =>
      expect(state().notices.map((notice) => notice.text)).toContain(RESTART_NOTICE),
    );
    expect(state().connection.phase).toBe("ready");
    for (const id of Object.keys(state().sessions)) {
      await vi.waitFor(() => expect(state().sessions[id]?.loaded).toBe(true));
      expect(transcriptProblems(state(), id)).toEqual([]);
    }
  });
});
