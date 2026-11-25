/**
 * The recorded sessions in ./fixtures: they parse, every path through them conforms to the
 * protocol, and they are exactly what the builder in ./record writes.
 */
import type { EngineEvent } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import { checkConformance } from "./conformance.ts";
import { formatRecording, type LoadedScenario, parseRecording, ScenarioSchema } from "./format.ts";
import { ALL_SCENARIOS } from "./record/all.ts";
import { BUILT_IN_SCENARIOS, loadScenarios } from "./scenarios.ts";

/** The fixture files as Vite reads them from disk. */
const FILES = import.meta.glob<string>("./fixtures/*/*", {
  query: "?raw",
  import: "default",
  eager: true,
});

function files(id: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, text] of Object.entries(FILES)) {
    const [folder, name] = path.split("/").slice(-2);
    if (folder === id && name !== undefined) out[name] = text;
  }
  return out;
}

/** Requests raised in `events` and not resolved there. */
function openRequests(events: readonly EngineEvent[]): string[] {
  const open = new Set<string>();
  for (const e of events) {
    if (e.event === "permission.requested") open.add(e.payload.request.requestId);
    else if (e.event === "question.asked" || e.event === "plan.proposed")
      open.add(e.payload.requestId);
    else if (e.event === "request.resolved") open.delete(e.payload.requestId);
  }
  return [...open];
}

/** The id an event brings into the session, if it starts something. */
function introducedId(e: EngineEvent): string[] {
  switch (e.event) {
    case "turn.started":
      return [e.payload.turnId];
    case "message.started":
      return [e.payload.messageId];
    case "tool.started":
      return [e.payload.toolCallId];
    case "permission.requested":
      return [e.payload.request.requestId];
    case "question.asked":
    case "plan.proposed":
      return [e.payload.requestId];
    case "compaction.started":
      return [e.payload.compactionId];
    default:
      return [];
  }
}

/**
 * Every way through a scenario, as lists of recording names: stored then live then each turn in
 * order, and stored (and live) then every branch of every request left open, recursively.
 */
function paths({ scenario, recordings }: LoadedScenario): string[][] {
  const base = [scenario.stored, scenario.live].filter((n): n is string => n !== null);
  const out: string[][] = [];
  const extend = (path: string[]) => {
    const events = path.flatMap((name) => recordings[name] ?? []);
    const open = openRequests(events);
    const branches = open.flatMap((id) => Object.values(scenario.branches[id] ?? {}));
    if (branches.length === 0) out.push(path);
    for (const name of new Set(branches)) extend([...path, name]);
  };
  extend(base);
  if (scenario.turns.length > 0) out.push([...base, ...scenario.turns]);
  return out;
}

describe.each(BUILT_IN_SCENARIOS.map((s) => [s.scenario.id, s] as const))(
  "fixture %s",
  (id, loaded) => {
    const { scenario, recordings } = loaded;

    it("has a valid scenario.json naming recordings that exist", () => {
      const raw = files(id);
      expect(ScenarioSchema.parse(JSON.parse(raw["scenario.json"] ?? "null"))).toEqual(scenario);
      const named = [
        scenario.stored,
        scenario.live,
        ...scenario.turns,
        ...Object.values(scenario.branches).flatMap((table) => Object.values(table)),
      ].filter((n): n is string => n !== null);
      for (const name of named) expect(raw[name], name).toBeDefined();
      for (const name of Object.keys(raw)) {
        if (name.endsWith(".jsonl")) expect(named, `${name} is not used`).toContain(name);
      }
    });

    it("parses every line of every recording", () => {
      for (const [name, text] of Object.entries(files(id))) {
        if (!name.endsWith(".jsonl")) continue;
        const events = parseRecording(text, `${id}/${name}`);
        expect(events.length).toBeGreaterThan(0);
        for (const line of text.trimEnd().split("\n")) {
          expect(Object.keys(JSON.parse(line))).toEqual(["event", "payload"]);
        }
      }
    });

    it("conforms to the protocol on every path through it", () => {
      const found = paths(loaded);
      expect(found.length).toBeGreaterThan(0);
      for (const path of found) {
        const events = path.flatMap((name) => recordings[name] ?? []);
        expect(checkConformance(events), path.join(" → ")).toEqual([]);
      }
    });

    it("starts each branch with its request.resolved and each turn with working, turn.started", () => {
      for (const [requestId, table] of Object.entries(scenario.branches)) {
        for (const name of Object.values(table)) {
          const first = recordings[name]?.[0];
          expect(first?.event, name).toBe("request.resolved");
          if (first?.event === "request.resolved") expect(first.payload.requestId).toBe(requestId);
        }
      }
      for (const name of scenario.turns) {
        expect(recordings[name]?.slice(0, 2).map((e) => e.event)).toEqual([
          "session.status",
          "turn.started",
        ]);
      }
    });

    it("never reuses an id on a path", () => {
      for (const path of paths(loaded)) {
        const starts = path.flatMap((name) => (recordings[name] ?? []).flatMap(introducedId));
        expect(new Set(starts).size, path.join(" → ")).toBe(starts.length);
      }
    });

    it("writes out every field the engine stores, defaults included", () => {
      for (const [name, text] of Object.entries(files(id))) {
        if (!name.endsWith(".jsonl")) continue;
        for (const line of text.trimEnd().split("\n")) {
          const { event, payload } = JSON.parse(line);
          const where = `${name}: ${event} ${payload.seq}`;
          if (event === "session.status") expect(payload, where).toHaveProperty("queuePosition");
          if (event === "plan.proposed")
            expect(payload.modeBeforePlan, where).toEqual(expect.any(String));
          if (event === "usage.updated") {
            const { usage } = payload;
            expect(usage.compactAt, where).toBe(Math.floor(usage.contextWindow * 0.65));
            const parts = usage.breakdown;
            expect(
              parts.systemPrompt + parts.instructions + parts.tools + parts.messages,
              where,
            ).toBe(usage.contextUsed);
          }
          if (event === "tool.finished" && payload.display?.kind === "command") {
            // A command started in the background has printed nothing yet: output is null.
            const output = payload.display.backgroundTaskId === null ? expect.any(String) : null;
            expect(payload.display.output, where).toEqual(output);
            expect(payload.display.notes, where).toEqual(expect.any(Array));
          }
        }
      }
    });

    it("writes paths under the home directory as ~/", () => {
      const text = Object.values(files(id)).join("\n");
      expect(text).not.toMatch(/\/Users\//);
      expect(scenario.session.cwd.startsWith("~/")).toBe(true);
    });
  },
);

describe("the fixtures", () => {
  it("are exactly what record/write-fixtures.ts writes", () => {
    for (const define of ALL_SCENARIOS) {
      const { scenario, recordings } = define();
      const raw = files(scenario.id);
      expect(raw["scenario.json"], scenario.id).toBe(`${JSON.stringify(scenario, null, 2)}\n`);
      for (const [name, events] of Object.entries(recordings)) {
        expect(raw[name], `${scenario.id}/${name}`).toBe(
          formatRecording(events as Parameters<typeof formatRecording>[0]),
        );
      }
    }
    expect(BUILT_IN_SCENARIOS.map((s) => s.scenario.id).sort()).toEqual(
      ALL_SCENARIOS.map((define) => define().scenario.id).sort(),
    );
  });

  it("load from any file map with loadScenarios", () => {
    const loaded = loadScenarios(FILES);
    expect(loaded.map((s) => s.scenario.id)).toEqual(BUILT_IN_SCENARIOS.map((s) => s.scenario.id));
  });

  it("have the session ids the design names", () => {
    expect(BUILT_IN_SCENARIOS.map((s) => s.scenario.id).sort()).toEqual([
      "broken-links",
      "docs-search",
      "export-md",
      "fix-split",
      "flaky-csv",
      "multi-currency",
      "python-313",
      "receipt-pdf",
      "tip-support",
    ]);
  });
});
