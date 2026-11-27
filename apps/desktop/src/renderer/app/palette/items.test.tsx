import { describe, expect, it } from "vitest";
import { makeSummary, T0 } from "../../state/__fixtures__/streams.ts";
import { SAMPLE_SESSIONS, sessionsStore, TALLY } from "../commands/testing.ts";
import {
  buildSource,
  MAX_SESSION_MATCHES,
  type PaletteSection,
  paletteSections,
  RECENT_SESSIONS,
  RECENT_SESSIONS_HEADING,
  RECENTLY_USED_HEADING,
} from "./items.ts";

const NOW = T0 + 60_000;

function titles(section: PaletteSection | undefined): string[] {
  return section?.rows.map((row) => row.title) ?? [];
}

describe("the palette's rows", () => {
  it("lists recent sessions first, then recently used actions, then every action by group", () => {
    const { store } = sessionsStore();
    const source = buildSource(store.getState(), NOW);
    const sections = paletteSections(source, "", ["session.fork", "appearance.dark", "gone"]);
    expect(sections[0]?.heading).toBe(RECENT_SESSIONS_HEADING);
    // The session showing is left out, and so is the archived one.
    expect(titles(sections[0])).toEqual([
      "Flaky CSV import test",
      "Docs search page",
      "Fix broken links in docs",
    ]);
    expect(sections[1]?.heading).toBe(RECENTLY_USED_HEADING);
    expect(titles(sections[1])).toEqual(["Fork the session", "Appearance: Dark"]);
    expect(sections.slice(2).map((section) => section.heading)).toEqual([
      "Sessions",
      "This session",
      "Composer",
      "Panes",
      "View",
      "Settings",
      "Models",
      "Help",
    ]);
    // Not twice, and nothing that cannot run.
    const all = sections.flatMap((section) => section.rows.map((row) => row.title));
    expect(all.filter((title) => title === "Fork the session")).toHaveLength(1);
    expect(all).not.toContain("Stop the running turn");
    expect(all).not.toContain("Show the command palette");
  });

  it("shows the project and time of each session", () => {
    const { store } = sessionsStore();
    const [first] = buildSource(store.getState(), NOW).sessions;
    expect(first?.row).toMatchObject({
      kind: "session",
      sessionId: "fix",
      title: "Fix the failing split test",
      detail: "tally · 1m",
      mark: "idle",
      current: true,
    });
  });

  it("finds sessions by title or project, and actions by title or keyword", () => {
    const { store } = sessionsStore();
    const source = buildSource(store.getState(), NOW);
    const csv = paletteSections(source, "csv", []);
    expect(csv[0]?.heading).toBe("Sessions");
    expect(titles(csv[0])[0]).toBe("Flaky CSV import test");

    const site = paletteSections(source, "dawg-site", []).flatMap((section) =>
      section.rows.map((row) => row.title),
    );
    expect(site).toEqual(
      expect.arrayContaining([
        "Docs search page",
        "Fix broken links in docs",
        "New session in dawg-site",
      ]),
    );

    const theme = paletteSections(source, "theme", []);
    expect(theme.flatMap((section) => section.rows.map((row) => row.title))).toEqual(
      expect.arrayContaining(["Appearance: Dark", "Appearance: Light", "Appearance: Match macOS"]),
    );
  });

  it("explains an action that cannot run when it is searched for", () => {
    const { store } = sessionsStore();
    const sections = paletteSections(buildSource(store.getState(), NOW), "stop", []);
    const stop = sections
      .flatMap((section) => section.rows)
      .find((row) => row.title === "Stop the running turn");
    expect(stop).toMatchObject({ disabled: "Nothing is running", detail: "Nothing is running" });
    // Below the ones that can run in its group (other groups keep their own order).
    const section = sections.find((candidate) => candidate.rows.includes(stop as never));
    expect(section?.rows.at(-1)).toBe(stop);
    expect(section?.rows.slice(0, -1).every((row) => !("disabled" in row) || !row.disabled)).toBe(
      true,
    );
  });

  it("puts the action above untitled sessions for “new session”", () => {
    const { store } = sessionsStore({
      summaries: [...SAMPLE_SESSIONS, makeSummary("blank", { title: null, projectDir: TALLY })],
    });
    const [first] = paletteSections(buildSource(store.getState(), NOW), "new session", []);
    expect(first?.rows[0]?.title).toBe("New session…");
  });

  it("floats recently used actions up a search", () => {
    const { store } = sessionsStore();
    const source = buildSource(store.getState(), NOW);
    const before = paletteSections(source, "appearance", [])[0]?.rows[0]?.title;
    const after = paletteSections(source, "appearance", ["appearance.system"])[0]?.rows[0]?.title;
    expect(before).not.toBe("Appearance: Match macOS");
    expect(after).toBe("Appearance: Match macOS");
  });

  it("stays quick with hundreds of sessions", () => {
    const many = Array.from({ length: 800 }, (_, index) =>
      makeSummary(`s${index}`, {
        title: `Session about topic ${index}`,
        cwd: TALLY,
        projectDir: TALLY,
        lastActivityAt: T0 - index * 1_000,
      }),
    );
    const { store } = sessionsStore({ summaries: many, open: {}, selected: null });
    const started = performance.now();
    const source = buildSource(store.getState(), NOW);
    let sections: PaletteSection[] = [];
    for (const query of ["s", "se", "ses", "sess", "topic 4", "topic 42"]) {
      sections = paletteSections(source, query, []);
    }
    const browse = paletteSections(source, "", []);
    expect(performance.now() - started).toBeLessThan(500);
    expect(browse[0]?.rows).toHaveLength(RECENT_SESSIONS);
    const sessions = paletteSections(source, "session", []).find(
      (section) => section.heading === "Sessions",
    );
    expect(sessions?.rows.filter((row) => row.kind === "session")).toHaveLength(
      MAX_SESSION_MATCHES,
    );
    expect(titles(sections[0])[0]).toBe("Session about topic 42");
  });
});
