import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { searchFromEnvironment } from "./start.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "dawg-cli-search-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("the command line's search service", () => {
  it("is none unless one is set", async () => {
    const lines: string[] = [];
    expect(await searchFromEnvironment({}, home, (l) => lines.push(l))).toBeNull();
    expect(lines).toEqual([]);
  });

  it("comes from the environment", async () => {
    const provider = await searchFromEnvironment(
      { DAWG_SEARCH_PROVIDER: "tavily", DAWG_SEARCH_API_KEY: "tvly-x" },
      home,
      () => {},
    );
    expect(provider?.label).toBe("Tavily");
  });

  it("falls back to the app's saved choice, which never holds the key", async () => {
    await writeFile(
      path.join(home, "web-search.json"),
      JSON.stringify({ provider: "searxng", searxngUrl: "http://localhost:8888" }),
    );
    expect((await searchFromEnvironment({}, home, () => {}))?.label).toBe("SearXNG");
    await writeFile(path.join(home, "web-search.json"), JSON.stringify({ provider: "brave" }));
    const lines: string[] = [];
    expect(await searchFromEnvironment({}, home, (l) => lines.push(l))).toBeNull();
    expect(lines).toEqual([
      "Web search is off: Brave Search needs an API key. Set DAWG_SEARCH_API_KEY.",
    ]);
    expect((await searchFromEnvironment({ DAWG_SEARCH_API_KEY: "k" }, home, () => {}))?.label).toBe(
      "Brave Search",
    );
  });
});
