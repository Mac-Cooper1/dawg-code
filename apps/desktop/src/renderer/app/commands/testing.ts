/**
 * Test helpers for the action registry, the command palette and Settings → Shortcuts (imported
 * by tests only): a store with fake actions (app/testing.tsx) holding real sessions, so the real
 * selectors and the registry's availability checks run against them.
 */
import type { SessionSnapshot, SessionSummary } from "@dawg/protocol";
import { makeSnapshot, makeSummary, T0 } from "../../state/__fixtures__/streams.ts";
import { emptyEngineSlice, reduceAll } from "../../state/reducer.ts";
import type { AppState, ReducerInput } from "../../state/types.ts";
import { createTestStore, HOME, TEST_MODELS, type TestStore } from "../testing.tsx";

export const TALLY = `${HOME}/code/tally`;
export const SITE = `${HOME}/code/dawg-site`;

/** Newest first: fix, csv, docs, links; "old" is archived. */
export const SAMPLE_SESSIONS: readonly SessionSummary[] = [
  makeSummary("fix", {
    title: "Fix the failing split test",
    cwd: TALLY,
    projectDir: TALLY,
    lastActivityAt: T0 - 1_000,
  }),
  makeSummary("csv", {
    title: "Flaky CSV import test",
    cwd: TALLY,
    projectDir: TALLY,
    lastActivityAt: T0 - 60_000,
  }),
  makeSummary("docs", {
    title: "Docs search page",
    cwd: SITE,
    projectDir: SITE,
    lastActivityAt: T0 - 120_000,
  }),
  makeSummary("links", {
    title: "Fix broken links in docs",
    cwd: SITE,
    projectDir: SITE,
    lastActivityAt: T0 - 3_600_000,
  }),
  makeSummary("old", {
    title: "Archived experiment",
    cwd: TALLY,
    projectDir: TALLY,
    lastActivityAt: T0,
    archived: true,
  }),
];

export interface SessionsStoreOptions {
  summaries?: readonly SessionSummary[];
  /** Sessions opened on this connection, with snapshot fields (a running turn). */
  open?: Record<string, Partial<Omit<SessionSnapshot, "session">>>;
  selected?: string | null;
  patch?: (state: AppState) => Partial<AppState>;
}

/** A store with fake actions holding real sessions. "fix" is open and selected by default. */
export function sessionsStore(options: SessionsStoreOptions = {}): TestStore {
  const summaries = options.summaries ?? SAMPLE_SESSIONS;
  const open = options.open ?? { fix: {} };
  const inputs: ReducerInput[] = [{ type: "summaries", sessions: [...summaries] }];
  for (const [id, overrides] of Object.entries(open)) {
    const summary = summaries.find((candidate) => candidate.id === id);
    if (summary) inputs.push({ type: "snapshot", snapshot: makeSnapshot(summary, overrides) });
  }
  const slice = reduceAll(emptyEngineSlice(), inputs);
  return createTestStore((state) => {
    const merged: AppState = {
      ...state,
      ...slice,
      models: TEST_MODELS,
      connection: { phase: "ready", engine: { name: "mock", version: "1" } },
      layout: {
        ...state.layout,
        selectedSessionId: options.selected === undefined ? "fix" : options.selected,
      },
    };
    return { ...merged, ...options.patch?.(merged) };
  });
}
