/** Hooks and project trust in the mock engine, through the protocol as a window sees them. */
import { ErrorCodes } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { all, type Harness, HOME, harness } from "./test-support.ts";

let h: Harness;
afterEach(() => h?.engine.dispose());

const NOTES = `${HOME}/code/notes-cli`;
const TALLY = `${HOME}/code/tally`;

describe("project trust", () => {
  it("starts with notes-cli's hooks approved, and nothing to approve elsewhere", async () => {
    h = harness();
    const peer = await h.connect();
    const notes = await peer.request("project.inspect", { projectDir: NOTES });
    expect(notes.approval).toMatchObject({ approved: true });
    expect(notes.approval?.items.map((item) => item.name)).toEqual([
      "PreToolUse on Bash: ./scripts/check-command.sh",
      "UserPromptSubmit: ./scripts/add-ticket-context.sh",
      "Stop: Check that the tests pass before stopping.",
    ]);
    expect(notes.items.find((item) => item.name.startsWith("Stop"))?.status).toBe("not-supported");
    const tally = await peer.request("project.inspect", { projectDir: TALLY });
    expect(tally.approval).toBeNull();
    // Other kinds of items come from the rest of the mock's report (compat.ts).
    const hooks = tally.items.filter((item) => item.kind === "hook");
    expect(hooks.map((item) => item.source.path)).toEqual([`${HOME}/.dawg/settings.json`]);
  });

  it("takes consent back and gives it again, refusing a hash it did not show", async () => {
    h = harness();
    const peer = await h.connect();
    const { approval } = await peer.request("project.inspect", { projectDir: NOTES });
    const hash = approval?.hash ?? "";
    expect(
      await peer.request("project.trust", { projectDir: NOTES, hash, approved: false }),
    ).toEqual({ approved: false });
    const waiting = await peer.request("project.inspect", { projectDir: NOTES });
    expect(waiting.approval?.approved).toBe(false);
    expect(waiting.approval?.items[0]?.status).toBe("needs-approval");
    const stale = await peer.failure("project.trust", {
      projectDir: NOTES,
      hash: "mock:other",
      approved: true,
    });
    expect(stale.code).toBe(ErrorCodes.InvalidState);
    await peer.request("project.trust", { projectDir: NOTES, hash, approved: true });
    expect((await peer.request("project.inspect", { projectDir: NOTES })).approval?.approved).toBe(
      true,
    );
  });
});

describe("hooks", () => {
  it("lists the hooks with their consent and switches, and turns one off", async () => {
    h = harness();
    const peer = await h.connect();
    const listed = await peer.request("hooks.list", { projectDir: NOTES });
    expect(listed.disabledBy).toBeNull();
    expect(listed.hooks.map((hook) => [hook.event, hook.status, hook.enabled])).toEqual([
      ["PreToolUse", "loaded", true],
      ["UserPromptSubmit", "loaded", true],
      ["Stop", "not-supported", true],
      ["Notification", "loaded", true],
    ]);
    const check = listed.hooks[0];
    expect(
      await peer.request("hooks.setEnabled", {
        projectDir: NOTES,
        id: check?.id ?? "",
        enabled: false,
      }),
    ).toEqual({ enabled: false });
    expect((await peer.request("hooks.list", { projectDir: NOTES })).hooks[0]?.enabled).toBe(false);
    const unknown = await peer.failure("hooks.setEnabled", {
      projectDir: NOTES,
      id: "hook:none",
      enabled: false,
    });
    expect(unknown.code).toBe(ErrorCodes.InvalidParams);
  });

  it("runs the project's UserPromptSubmit hook before a prompt's turn, while it may run", async () => {
    h = harness({ speed: Number.POSITIVE_INFINITY });
    const peer = await h.connect();
    const { session } = await peer.request("session.create", { cwd: NOTES });
    await peer.request("session.prompt", {
      sessionId: session.id,
      prompt: { content: [{ type: "text", text: "Add a --json flag" }] },
    });
    await h.runAll();
    const events = peer.of(session.id);
    const ran = all(events, "hook.ran");
    expect(ran).toHaveLength(1);
    expect(ran[0]?.payload).toMatchObject({
      turnId: null,
      hook: { event: "UserPromptSubmit", command: "./scripts/add-ticket-context.sh" },
      outcome: "success",
    });
    const names = events.map((event) => event.event);
    expect(names.indexOf("hook.ran")).toBeLessThan(names.indexOf("turn.started"));

    // Turned off, it does not run.
    const listed = await peer.request("hooks.list", { projectDir: NOTES });
    const id = listed.hooks.find((hook) => hook.event === "UserPromptSubmit")?.id ?? "";
    await peer.request("hooks.setEnabled", { projectDir: NOTES, id, enabled: false });
    await peer.request("session.prompt", {
      sessionId: session.id,
      prompt: { content: [{ type: "text", text: "And a --yaml flag" }] },
    });
    await h.runAll();
    expect(all(peer.of(session.id), "hook.ran")).toHaveLength(1);
  });

  it("runs nothing for a project without hooks", async () => {
    h = harness({ speed: Number.POSITIVE_INFINITY });
    const peer = await h.connect();
    const { session } = await peer.request("session.create", { cwd: "/work/app" });
    await peer.request("session.prompt", {
      sessionId: session.id,
      prompt: { content: [{ type: "text", text: "Hello" }] },
    });
    await h.runAll();
    expect(all(peer.of(session.id), "hook.ran")).toEqual([]);
  });
});
