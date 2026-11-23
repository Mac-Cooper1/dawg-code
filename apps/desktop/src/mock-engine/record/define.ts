/**
 * What each scenario script returns, and helpers they share.
 */
import type { EngineEventInput } from "@dawg/protocol";
import type { Scenario } from "../format.ts";
import { Recorder, type SessionSettings, type TurnStats } from "./recorder.ts";

export interface ScenarioDefinition {
  scenario: Scenario;
  /** Recording file name → events, in order. */
  recordings: Record<string, EngineEventInput[]>;
  /** Turn figures per recording, printed by the fixture script for checking by eye. */
  stats: { recording: string; turns: TurnStats[] }[];
}

/** Recorded times start here; the engine rebases them, so the date itself does not matter. */
export const RECORDED_EPOCH = Date.UTC(2026, 10, 22, 9, 0, 0);

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const DEFAULT_MODEL = "qwen3.8-27b-q8";

export function settings(overrides: Partial<SessionSettings> & { title: string }): SessionSettings {
  return {
    mode: "default",
    model: DEFAULT_MODEL,
    effort: null,
    archived: false,
    additionalDirectories: [],
    ...overrides,
  };
}

export function recorder(options: {
  id: string;
  cwd: string;
  settings: SessionSettings;
  seed: number;
  startTime?: number;
}): Recorder {
  return new Recorder({
    sessionId: options.id,
    cwd: options.cwd,
    settings: options.settings,
    startTime: options.startTime ?? RECORDED_EPOCH,
    seed: options.seed,
  });
}

/** Collects recordings and the turn figures of the recorders that made them. */
export class Recordings {
  readonly recordings: Record<string, EngineEventInput[]> = {};
  readonly stats: { recording: string; turns: TurnStats[] }[] = [];

  /** Takes what `rec` recorded since its last take as the recording `name`. */
  add(name: string, rec: Recorder): string {
    if (this.recordings[name] !== undefined) throw new Error(`Recording ${name} exists already`);
    this.recordings[name] = rec.take();
    this.stats.push({ recording: name, turns: rec.takeStats() });
    return name;
  }
}

/** Prompt text in the scenario scripts can span lines; the person typed it as one paragraph. */
export function lines(...parts: string[]): string {
  return parts.join("\n");
}
