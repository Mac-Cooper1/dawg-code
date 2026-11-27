/**
 * The compatibility suite (Phase 4 spec, Testing → Fixtures): every fixture in COMPAT_FIXTURES is
 * written into a temporary folder, and the report made for it must hold exactly the items the
 * fixture expects. Consent (`expected.approval`) is the engine's to check, with its trust store.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompatItemSchema } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { COMPAT_FIXTURES, fixtureDifferences, materialiseFixture } from "../fixtures/index.ts";
import { buildCompatReport } from "./build.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dawg-compat-fixture-"));
  roots.push(root);
  return root;
}

describe("the compatibility suite", () => {
  it("has fixtures, each with a description", () => {
    expect(Object.keys(COMPAT_FIXTURES).length).toBeGreaterThan(0);
    for (const [name, fixture] of Object.entries(COMPAT_FIXTURES)) {
      expect(fixture.description.trim(), name).not.toBe("");
    }
  });

  it.each(Object.entries(COMPAT_FIXTURES))("%s", async (_name, fixture) => {
    const root = await fixtureRoot();
    const { homeDir, projectDir } = await materialiseFixture(fixture, root);
    const report = await buildCompatReport({ homeDir, projectDir });
    expect(report.projectDir).toBe(projectDir);
    for (const item of report.items) expect(CompatItemSchema.parse(item)).toEqual(item);
    expect(fixtureDifferences(fixture, report.items)).toEqual([]);
    // Every source is a real file the fixture wrote.
    for (const item of report.items) {
      if (item.status === "invalid" && item.kind === "other") continue;
      await expect(stat(item.source.path)).resolves.toBeTruthy();
    }
  });

  it("writes `.sh` files executable and fills in the folders", async () => {
    const root = await fixtureRoot();
    const { homeDir, projectDir } = await materialiseFixture(
      {
        description: "x",
        files: {
          "project/.claude/hooks/check.sh": "#!/bin/sh\nexit 0\n",
          "home/.claude.json": '{"projects":{"{{project}}":{}},"home":"{{home}}"}',
        },
        expected: { items: [], approval: null },
      },
      root,
    );
    const info = await stat(join(projectDir, ".claude", "hooks", "check.sh"));
    expect(info.mode & 0o111).not.toBe(0);
    const json = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf8"));
    expect(json).toEqual({ projects: { [projectDir]: {} }, home: homeDir });
  });

  it("reports what differs from a fixture", () => {
    const fixture = COMPAT_FIXTURES["report/empty-home"];
    if (!fixture) throw new Error("missing fixture");
    expect(
      fixtureDifferences(
        {
          ...fixture,
          expected: {
            items: [
              {
                kind: "agent",
                name: "a",
                scope: "user",
                origin: "claude",
                status: "loaded",
                notes: ["x"],
              },
            ],
            approval: null,
          },
        },
        [
          {
            kind: "agent",
            name: "a",
            source: { path: "/a.md", origin: "claude", scope: "user" },
            status: "not-supported",
            notes: ["y"],
          },
          {
            kind: "skill",
            name: "b",
            source: { path: "/b.md", origin: "claude", scope: "user" },
            status: "loaded",
            notes: [],
          },
        ],
      ),
    ).toEqual([
      "agent “a” (user, claude) is not-supported, expected loaded.",
      'agent “a” (user, claude) has no note containing “x”; its notes: ["y"].',
      "Unexpected skill “b” (user, claude): loaded, [].",
    ]);
  });
});
