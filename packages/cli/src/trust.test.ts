/**
 * Project code on the command line: `-p` never runs it unapproved (one notice on standard
 * error), `--approve-project-code` approves it first, and interactive `dawg` asks once.
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { text } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./__fixtures__/harness.ts";
import { EXIT } from "./exit-codes.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

/** A project whose shared Claude Code settings run a hook on every prompt and at start. */
async function projectWithHooks(harness: Harness): Promise<void> {
  await mkdir(path.join(harness.project, ".claude"), { recursive: true });
  await writeFile(
    path.join(harness.project, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: 'touch "$CLAUDE_PROJECT_DIR/started"' }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: 'touch "$CLAUDE_PROJECT_DIR/prompted"' }] },
        ],
      },
    }),
  );
}

describe("project code on the command line", () => {
  it("-p runs none of it unapproved, and says so once", async () => {
    h = await startHarness({ script: [text("Done.")] });
    await projectWithHooks(h);
    const result = await h.run(["-p", "hi", "--endpoint", h.mock.baseUrl]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toBe("Done.\n");
    expect(await exists(path.join(h.project, "prompted"))).toBe(false);
    expect(await exists(path.join(h.project, "started"))).toBe(false);
    const notices = result.stderr.split("\n").filter((l) => l.includes("wait for your approval"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("--approve-project-code");
  });

  it("--approve-project-code approves what the project defines before the session opens", async () => {
    h = await startHarness({ script: [text("Done."), text("Again.")] });
    await projectWithHooks(h);
    const result = await h.run([
      "-p",
      "hi",
      "--approve-project-code",
      "--endpoint",
      h.mock.baseUrl,
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stderr).toContain("Approved 2 items of project code");
    expect(await exists(path.join(h.project, "prompted"))).toBe(true);
    expect(await exists(path.join(h.project, "started"))).toBe(true);
    // The approval is kept: the next run needs no flag.
    const { rm } = await import("node:fs/promises");
    await rm(path.join(h.project, "prompted"));
    const again = await h.run(["-p", "hi", "--endpoint", h.mock.baseUrl]);
    expect(again.code).toBe(EXIT.ok);
    expect(await exists(path.join(h.project, "prompted"))).toBe(true);
    expect(again.stderr).not.toContain("wait for your approval");
  });

  it("interactive dawg asks once before the first prompt", async () => {
    h = await startHarness({ script: [text("Hello.")] });
    await projectWithHooks(h);
    const result = await h.run(["--endpoint", h.mock.baseUrl], { stdin: "y\nhi\n" });
    expect(result.code).toBe(EXIT.ok);
    expect(result.stderr).toContain("waits for your approval");
    expect(result.stderr).toContain("UserPromptSubmit: touch");
    expect(result.stderr).toContain("Approved.");
    expect(await exists(path.join(h.project, "prompted"))).toBe(true);
    expect(await exists(path.join(h.project, "started"))).toBe(true);
  });

  it("interactive dawg keeps it off on no, and runs the prompt", async () => {
    h = await startHarness({ script: [text("Hello.")] });
    await projectWithHooks(h);
    const result = await h.run(["--endpoint", h.mock.baseUrl], { stdin: "n\nhi\n" });
    expect(result.code).toBe(EXIT.ok);
    expect(result.stderr).toContain("They stay off for this run");
    expect(result.stdout).toContain("Hello.");
    expect(await exists(path.join(h.project, "prompted"))).toBe(false);
  });
});
