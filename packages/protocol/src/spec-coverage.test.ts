/**
 * Every method and event named in the Phase 2 spec's protocol tables must exist in the
 * registries. The names are read from the spec itself, so the two cannot drift apart silently.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { events, isEventName } from "./events.ts";
import { isMethodName, methods } from "./methods.ts";

const specPath = fileURLToPath(
  new URL("../../../docs/specs/phase-2-engine-core.md", import.meta.url),
);

function namesInTable(markdown: string, heading: string): string[] {
  const start = markdown.indexOf(heading);
  expect(start, `heading ${heading}`).toBeGreaterThanOrEqual(0);
  const lines = markdown.slice(start + heading.length).split("\n");
  const names: string[] = [];
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith("|")) {
      inTable = true;
      const firstCell = line.split("|")[1] ?? "";
      for (const match of firstCell.matchAll(/`([^`]+)`/g)) {
        if (match[1]) names.push(match[1]);
      }
    } else if (inTable) {
      break;
    }
  }
  return names;
}

const spec = readFileSync(specPath, "utf8");
const specMethods = namesInTable(spec, "**Requests (client → engine)**");
const specEvents = namesInTable(spec, "**Events (engine → client)**");

test("the spec tables were read", () => {
  expect(specMethods).toHaveLength(16);
  expect(specEvents).toHaveLength(17);
});

test("every method in the spec is in the registry", () => {
  const missing = specMethods.filter((name) => !isMethodName(name));
  expect(missing).toEqual([]);
  for (const name of specMethods) expect(methods).toHaveProperty([name]);
});

test("every event in the spec is in the registry", () => {
  const missing = specEvents.filter((name) => !isEventName(name));
  expect(missing).toEqual([]);
  for (const name of specEvents) expect(events).toHaveProperty([name]);
});
