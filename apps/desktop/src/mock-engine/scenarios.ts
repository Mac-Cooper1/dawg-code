/**
 * The recorded sessions in ./fixtures, loaded through Vite (`?raw`), so the same code works in
 * the Electron build, the browser fallback and Vitest. Fixtures are written by
 * `node src/mock-engine/record/write-fixtures.ts`.
 */
import { type LoadedScenario, parseRecording, RecordingError, ScenarioSchema } from "./format.ts";

const FIXTURE_FILES = import.meta.glob<string>("./fixtures/*/*.{json,jsonl}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * Parses fixture files into scenarios. `files` maps a path ending in `<scenario>/<file>` to the
 * file's text; every scenario.json becomes one scenario, with the recordings beside it. Sorted
 * by scenario id.
 */
export function loadScenarios(files: Readonly<Record<string, string>>): LoadedScenario[] {
  const folders = new Map<string, Map<string, string>>();
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split("/");
    const name = parts.at(-1);
    const folder = parts.at(-2);
    if (name === undefined || folder === undefined) continue;
    let entries = folders.get(folder);
    if (entries === undefined) {
      entries = new Map();
      folders.set(folder, entries);
    }
    entries.set(name, text);
  }
  const out: LoadedScenario[] = [];
  for (const [folder, entries] of folders) {
    const json = entries.get("scenario.json");
    if (json === undefined) continue;
    const scenario = ScenarioSchema.parse(JSON.parse(json));
    if (scenario.id !== folder) {
      throw new RecordingError(`${folder}/scenario.json has the id ${scenario.id}, not ${folder}`);
    }
    const recordings: LoadedScenario["recordings"] = {};
    for (const [name, text] of entries) {
      if (name.endsWith(".jsonl")) recordings[name] = parseRecording(text, `${folder}/${name}`);
    }
    out.push({ scenario, recordings });
  }
  return out.sort((a, b) => a.scenario.id.localeCompare(b.scenario.id));
}

/** The recorded sessions in `./fixtures`, parsed. */
export const BUILT_IN_SCENARIOS: readonly LoadedScenario[] = loadScenarios(FIXTURE_FILES);
