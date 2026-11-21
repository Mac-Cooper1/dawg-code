import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type ScriptReply, text, toolCall, toolCalls } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./__fixtures__/harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

interface Body {
  messages: unknown[];
  tools?: unknown[];
}

/** The main conversation's requests, in order (side lanes such as titles left out). */
function mainBodies(harness: Harness): Body[] {
  return harness.mock.chatRequests.filter((r) => r.lane === "main").map((r) => r.body as Body);
}

describe("cache stability", () => {
  it("each request begins with the previous request's entire message list, byte for byte", async () => {
    h = await startHarness({
      // Nobody answers prompts here: anything that would ask is denied, and the turn goes on.
      engine: { capabilities: { permissionPrompts: false } },
      files: {
        "src/a.ts": "export const a = 1;\n",
        "src/b.ts": "export const b = 2;\n",
        "src/CLAUDE.md": "Prefer small functions.\n",
        "README.md": "# Project\n",
      },
      script: [
        // Turn 1: read-only calls side by side, then an answer.
        toolCalls([
          { name: "Read", arguments: { file_path: "README.md" } },
          { name: "Glob", arguments: { pattern: "src/*.ts" } },
        ]),
        toolCall("Read", { file_path: "src/a.ts" }),
        text("Read them."),
        // Turn 2: after a mode change: a write, a background command and the task list.
        toolCall("Write", { file_path: "src/c.ts", content: "export const c = 3;\n" }),
        toolCall("Bash", { command: "echo background", run_in_background: true }),
        toolCall("TodoWrite", { todos: [{ content: "Check c", status: "in_progress" }] }),
        text("Wrote c."),
        // Turn 3: after a directory was added: an edit, a search, a denied call.
        toolCall("Edit", { file_path: "src/c.ts", old_string: "3", new_string: "4" }),
        toolCall("Grep", { pattern: "export", path: "src" }),
        toolCall("Bash", { command: "rm -rf src" }),
        text("Done."),
        // Turn 4: a plain question.
        text("Bye."),
      ],
    });
    const extra = path.join(h.root, "extra");
    await mkdir(extra);
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("Look around"));
    session.setMode("acceptEdits");
    await session.run(ask("Write c"));
    await session.addDirectory(extra);
    await session.run(ask("Edit c"));
    await session.run(ask("Thanks"));

    const bodies = mainBodies(h);
    expect(bodies.length).toBe(12);
    for (let i = 1; i < bodies.length; i++) {
      const previous = JSON.stringify((bodies[i - 1] as Body).messages);
      const current = (bodies[i] as Body).messages;
      const head = JSON.stringify(current.slice(0, (bodies[i - 1] as Body).messages.length));
      expect(head, `request ${i} rewrote earlier messages`).toBe(previous);
      expect(current.length).toBeGreaterThan((bodies[i - 1] as Body).messages.length);
      expect(JSON.stringify(bodies[i]?.tools)).toBe(JSON.stringify(bodies[0]?.tools));
    }
    // Later facts arrived as appended notes, not as edits to earlier text.
    const last = JSON.stringify(bodies.at(-1)?.messages);
    for (const note of ["mode_changed", "directory_added", "instructions_added"]) {
      expect(last, note).toContain(note);
    }
    // The raw bodies agree too, up to where the previous request's messages end.
    const raw = h.mock.chatRequests.filter((r) => r.lane === "main").map((r) => r.rawBody);
    for (let i = 1; i < raw.length; i++) {
      const prev = raw[i - 1] as string;
      const cut = prev.indexOf('"messages":[') + '"messages":['.length;
      const prevMessages = JSON.stringify((bodies[i - 1] as Body).messages).slice(1, -1);
      expect((raw[i] as string).slice(cut, cut + prevMessages.length)).toBe(prevMessages);
    }
    h.mock.assertDone();
  });
});

describe("resume", () => {
  /** One session: a turn, a mode change, then (optionally after a restart) a second turn. */
  async function runSession(
    harness: Harness,
    restart: boolean,
  ): Promise<{ id: string; bodies: Body[] }> {
    const before = harness.mock.chatRequests.length;
    let engine = harness.engine;
    let session = await engine.createSession({ cwd: harness.project });
    await session.run(ask("Read the sub file"));
    session.setMode("acceptEdits");
    if (restart) {
      await engine.close();
      engine = harness.newEngine();
      session = await engine.resumeSession(session.id);
    }
    await session.run(ask("Read the other one"));
    const bodies = harness.mock.chatRequests.slice(before).map((r) => r.body as Body);
    await session.close();
    return { id: session.id, bodies };
  }

  it("sends exactly the request the original session would have sent", async () => {
    const turn = (): ScriptReply[] => [
      toolCall("Read", { file_path: "sub/a.txt" }, { id: "read-a" }),
      text("ok 1"),
      toolCall("Read", { file_path: "sub/b.txt" }, { id: "read-b" }),
      text("ok 2"),
    ];
    h = await startHarness({
      files: { "sub/CLAUDE.md": "Sub rules.\n", "sub/a.txt": "a\n", "sub/b.txt": "b\n" },
      script: [...turn(), ...turn()],
    });
    const original = await runSession(h, false);
    const resumed = await runSession(h, true);
    expect(original.bodies).toHaveLength(4);
    expect(resumed.bodies).toHaveLength(4);
    // The requests of the turn after the restart, whole bodies included.
    expect(JSON.stringify(resumed.bodies[2])).toBe(JSON.stringify(original.bodies[2]));
    expect(JSON.stringify(resumed.bodies[3])).toBe(JSON.stringify(original.bodies[3]));
    // The mode change reached the model in both, once.
    const notes = JSON.stringify(original.bodies[2]?.messages).match(/mode_changed/g) ?? [];
    expect(notes).toHaveLength(1);
    // The nested instruction file was delivered once, not again after the resume.
    const instructions =
      JSON.stringify(resumed.bodies[3]?.messages).match(/instructions_added/g) ?? [];
    expect(instructions).toHaveLength(1);
    h.mock.assertDone();
  });
});
