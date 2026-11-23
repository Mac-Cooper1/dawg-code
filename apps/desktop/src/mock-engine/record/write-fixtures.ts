/**
 * Writes the recorded sessions to ../fixtures, one folder per scenario:
 *
 *   node src/mock-engine/record/write-fixtures.ts           (from apps/desktop)
 *
 * Each folder gets scenario.json and the .jsonl recordings it names, in the stream-json shape
 * (`{"event": ..., "payload": ...}` per line). Folders of scenarios that no longer exist are left
 * alone; delete them by hand. The script prints each turn's figures (duration, model requests,
 * share of the prompt read from cache, context used) so they can be checked against the design.
 *
 * Runs on Node directly (type stripping), so it imports nothing Vite-specific. Node's file API is
 * loaded through a computed import so this folder still type-checks without Node's types.
 */
import { formatRecording, parseRecording, ScenarioSchema } from "../format.ts";
import { ALL_SCENARIOS } from "./all.ts";

interface NodeFs {
  mkdirSync(path: URL, options: { recursive: true }): void;
  writeFileSync(path: URL, data: string): void;
}

const fsModule = "node:fs";
const fs = (await import(fsModule)) as NodeFs;
const root = new URL("../fixtures/", import.meta.url);

for (const define of ALL_SCENARIOS) {
  const { scenario, recordings, stats } = define();
  ScenarioSchema.parse(scenario);
  const dir = new URL(`${scenario.id}/`, root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(new URL("scenario.json", dir), `${JSON.stringify(scenario, null, 2)}\n`);
  for (const [name, events] of Object.entries(recordings)) {
    const text = formatRecording(events as Parameters<typeof formatRecording>[0]);
    // Every line must parse back exactly as the engine and the reducer tests will read it.
    parseRecording(text, `${scenario.id}/${name}`);
    fs.writeFileSync(new URL(name, dir), text);
  }
  console.log(`${scenario.id}: ${Object.keys(recordings).length} recordings`);
  for (const { recording, turns } of stats) {
    for (const t of turns) {
      console.log(
        `  ${recording} ${t.turnId}: ${(t.durationMs / 1000).toFixed(1)} s, ${t.requests} requests, ` +
          `${(t.cacheRatio * 100).toFixed(1)}% cached, context ${t.contextUsed.toLocaleString("en-US")}`,
      );
    }
  }
}
