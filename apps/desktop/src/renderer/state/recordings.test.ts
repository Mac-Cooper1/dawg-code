/**
 * The reducer against recorded event streams (the spec's unit-test requirement): every JSONL
 * recording of the mock engine's scenarios, plus this folder's hand-built streams written out
 * and read back through the same recording format.
 *
 * Fixtures are found with `import.meta.glob`, so the test passes before any exist and covers
 * each one as it lands.
 */
import type { EngineEvent } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import {
  formatRecording,
  parseRecording,
  type Scenario,
  ScenarioSchema,
} from "../../mock-engine/format.ts";
import { transcriptProblems } from "./__fixtures__/invariants.ts";
import { finishInterrupted, fullTurn, interruptedTurn } from "./__fixtures__/scenarios.ts";
import {
  applyLive,
  applyReplay,
  comparable,
  createStream,
  HOME,
  makeSummary,
  openSession,
  withoutStreaming,
} from "./__fixtures__/streams.ts";
import type { EngineSlice } from "./types.ts";

const scenarioFiles = import.meta.glob<unknown>("../../mock-engine/fixtures/*/scenario.json", {
  eager: true,
  import: "default",
});
const recordingFiles = import.meta.glob<string>("../../mock-engine/fixtures/*/*.jsonl", {
  eager: true,
  query: "?raw",
  import: "default",
});

function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? `${HOME}${path.slice(1)}` : path;
}

/** Joins recordings into one session history, numbered from 1 like the engine would. */
function chain(sessionId: string, parts: readonly (readonly EngineEvent[])[]): EngineEvent[] {
  return parts
    .flat()
    .map(
      (event, index) =>
        ({ ...event, payload: { ...event.payload, sessionId, seq: index + 1 } }) as EngineEvent,
    );
}

interface Case {
  name: string;
  sessionId: string;
  scenario: Scenario | null;
  events: EngineEvent[];
}

function scenarioCases(): Case[] {
  const cases: Case[] = [];
  for (const [path, raw] of Object.entries(scenarioFiles)) {
    const scenario = ScenarioSchema.parse(raw);
    const folder = folderOf(path);
    const load = (name: string | null): EngineEvent[] => {
      if (name === null) return [];
      const text = recordingFiles[`${folder}/${name}`];
      if (text === undefined) throw new Error(`${scenario.id}: missing recording ${name}`);
      return parseRecording(text, `${scenario.id}/${name}`);
    };
    const prefix = [load(scenario.stored), load(scenario.live)];
    cases.push({
      name: `${scenario.id}: stored and live`,
      sessionId: scenario.id,
      scenario,
      events: chain(scenario.id, prefix),
    });
    for (const [requestId, table] of Object.entries(scenario.branches)) {
      for (const [key, name] of Object.entries(table)) {
        cases.push({
          name: `${scenario.id}: ${requestId} → ${key}`,
          sessionId: scenario.id,
          scenario,
          events: chain(scenario.id, [...prefix, load(name)]),
        });
      }
    }
    if (scenario.turns.length > 0) {
      // Turns follow an idle session: settle any decision first with its first branch.
      const firstBranch = Object.values(scenario.branches)[0];
      const settle = firstBranch ? Object.values(firstBranch)[0] : undefined;
      const turns = scenario.turns.map((name) => load(name));
      cases.push({
        name: `${scenario.id}: every turn`,
        sessionId: scenario.id,
        scenario,
        events: chain(scenario.id, [...prefix, load(settle ?? null), ...turns]),
      });
    }
  }
  return cases;
}

/** This folder's streams, through the recording format. */
function handBuiltCases(): Case[] {
  const stream = createStream("hand-built");
  fullTurn(stream);
  interruptedTurn(stream);
  finishInterrupted(stream);
  fullTurn(stream, {
    turnId: "t3",
    usageBefore: { requests: 2, promptTokens: 45_000, cachedTokens: 40_000 },
  });
  const events = parseRecording(formatRecording(stream.events), "hand-built.jsonl");
  return [{ name: "hand-built: three turns", sessionId: "hand-built", scenario: null, events }];
}

function baseState(item: Case): EngineSlice {
  const lastSeq = item.events.length;
  if (!item.scenario) return openSession(makeSummary(item.sessionId, { lastSeq }));
  const { session } = item.scenario;
  return openSession(
    makeSummary(item.sessionId, {
      title: session.title,
      cwd: expandHome(session.cwd),
      projectDir: expandHome(session.projectDir),
      mode: session.mode,
      model: session.model,
      effort: session.effort,
      lastSeq,
    }),
  );
}

const cases = [...scenarioCases(), ...handBuiltCases()];

describe("recorded event streams", () => {
  it("finds the mock engine's recordings (there may be none yet)", () => {
    for (const [path, text] of Object.entries(recordingFiles)) {
      expect(() => parseRecording(text, path)).not.toThrow();
    }
    expect(cases.length).toBeGreaterThanOrEqual(1);
  });

  for (const item of cases) {
    describe(item.name, () => {
      const live = applyLive(baseState(item), item.events);

      it("applies live without problems", () => {
        expect(transcriptProblems(live, item.sessionId)).toEqual([]);
        expect(live.sessions[item.sessionId]?.highWaterSeq).toBe(item.events.length);
      });

      it("rebuilds the same transcript from a replay", () => {
        const replayed = applyReplay(baseState(item), item.sessionId, item.events, 25);
        expect(transcriptProblems(replayed, item.sessionId)).toEqual([]);
        expect(replayed.transcripts[item.sessionId]).toEqual(live.transcripts[item.sessionId]);
        expect(replayed.pending[item.sessionId]).toEqual(live.pending[item.sessionId]);
      });

      it("rebuilds the same items from a replay without deltas and progress", () => {
        const replayed = applyReplay(
          baseState(item),
          item.sessionId,
          withoutStreaming(item.events),
          25,
        );
        expect(transcriptProblems(replayed, item.sessionId)).toEqual([]);
        expect(comparable(replayed.transcripts[item.sessionId] ?? [])).toEqual(
          comparable(live.transcripts[item.sessionId] ?? []),
        );
        expect(replayed.pending[item.sessionId]).toEqual(live.pending[item.sessionId]);
      });

      it("ignores the whole stream applied a second time", () => {
        expect(applyLive(live, item.events)).toBe(live);
      });
    });
  }
});
