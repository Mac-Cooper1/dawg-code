import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { text, toolCall, toolCalls } from "@dawg/mock-model";
import type { PermissionMode, PermissionRequest, PermissionResponse } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness, textOf } from "./__fixtures__/harness.ts";
import type { LoggedEvent } from "./event-log.ts";
import type { SessionRuntime } from "./session.ts";

let h: Harness | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

/** Answers every permission request of a session with `answer`, recording the requests. */
function autoAnswer(
  harness: Harness,
  session: SessionRuntime,
  answer: (request: PermissionRequest) => PermissionResponse,
): PermissionRequest[] {
  const seen: PermissionRequest[] = [];
  session.subscribe((event: LoggedEvent) => {
    if (event.event !== "permission.requested") return;
    const request = event.payload.request as PermissionRequest;
    seen.push(request);
    // Answered after the current event has been handed out, as a client would.
    setImmediate(() => session.respondPermission(request.requestId, answer(request)));
  });
  void harness;
  return seen;
}

function outcomes(harness: Harness, sessionId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of harness.ofType(sessionId, "tool.finished")) {
    out[String(e.payload.toolName)] = String(e.payload.outcome);
  }
  return out;
}

describe("permission paths", () => {
  it("allows by mode: acceptEdits writes inside the working directory without asking", async () => {
    h = await startHarness({
      script: [toolCall("Write", { file_path: "a.txt", content: "x\n" }), text("ok")],
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "acceptEdits" });
    await session.run(ask("write"));
    expect(h.ofType(session.id, "permission.requested")).toHaveLength(0);
    expect(await readFile(path.join(h.project, "a.txt"), "utf8")).toBe("x\n");
  });

  it("allows by rule", async () => {
    h = await startHarness({
      files: {
        ".dawg/settings.json": JSON.stringify({ permissions: { allow: ["Bash(touch *)"] } }),
      },
      script: [toolCall("Bash", { command: "touch made.txt" }), text("ok")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("touch"));
    expect(h.ofType(session.id, "permission.requested")).toHaveLength(0);
    expect(await exists(path.join(h.project, "made.txt"))).toBe(true);
  });

  it("asks, waits, and runs once when allowed once; asks again next time", async () => {
    h = await startHarness({
      script: [
        toolCall("Write", { file_path: "a.txt", content: "one\n" }),
        toolCall("Write", { file_path: "a.txt", content: "two\n" }, { id: "second" }),
        text("ok"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.prompt(ask("write"));
    const requested = await h.waitFor((e) => e.event === "permission.requested");
    expect(session.status).toBe("waiting");
    const status = h.ofType(session.id, "session.status").at(-1)?.payload;
    expect(status).toMatchObject({ status: "waiting", waitingOn: "permission" });
    expect(session.snapshot().pending).toHaveLength(1);
    const request = requested.payload.request as PermissionRequest;
    expect(request.toolName).toBe("Write");
    expect(request.title).not.toBe("");
    expect(() =>
      session.respondPermission("no-such-request", { behavior: "allow", scope: "once" }),
    ).toThrow(expect.objectContaining({ code: "RequestNotFound" }));
    session.respondPermission(request.requestId, { behavior: "allow", scope: "once" });
    const second = await h.waitFor(
      (e) => e.event === "permission.requested" && e.payload.seq > requested.payload.seq,
    );
    expect(await readFile(path.join(h.project, "a.txt"), "utf8")).toBe("one\n");
    session.respondPermission((second.payload.request as PermissionRequest).requestId, {
      behavior: "allow",
      scope: "once",
    });
    const outcome = await session.waitForIdle();
    expect(outcome?.stopReason).toBe("completed");
    expect(await readFile(path.join(h.project, "a.txt"), "utf8")).toBe("two\n");
    expect(h.ofType(session.id, "request.resolved").map((e) => e.payload.outcome)).toEqual([
      "answered",
      "answered",
    ]);
  });

  it("saves an always rule and applies it to the running session at once", async () => {
    h = await startHarness({
      script: [
        toolCall("Bash", { command: "touch one.txt" }),
        toolCall("Bash", { command: "touch one.txt" }),
        text("ok"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const seen = autoAnswer(h, session, () => ({ behavior: "allow", scope: "always" }));
    await session.run(ask("touch twice"));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.suggestions.length).toBeGreaterThan(0);
    const saved = JSON.parse(
      await readFile(path.join(h.project, ".dawg", "settings.local.json"), "utf8"),
    );
    expect(saved.permissions.allow).toEqual(seen[0]?.suggestions);
    expect(outcomes(h, session.id)).toEqual({ Bash: "success" });
  });

  it("denies with the person's message given to the model", async () => {
    h = await startHarness({
      script: [toolCall("Write", { file_path: "a.txt", content: "x" }), text("understood")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    autoAnswer(h, session, () => ({ behavior: "deny", message: "not that file" }));
    const outcome = await session.run(ask("write"));
    expect(outcome.finalText).toBe("understood");
    const result = session.view.find((m) => m.role === "tool");
    expect(result?.role === "tool" && result.isError).toBe(true);
    expect(textOf(result)).toContain("not that file");
    expect(outcomes(h, session.id)).toEqual({ Write: "denied" });
    expect(await exists(path.join(h.project, "a.txt"))).toBe(false);
  });

  it("denies an ask when nobody can answer (headless)", async () => {
    h = await startHarness({
      engine: { capabilities: { permissionPrompts: false } },
      script: [toolCall("Bash", { command: "touch z.txt" }), text("ok")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("touch"));
    expect(h.ofType(session.id, "permission.requested")).toHaveLength(0);
    expect(outcomes(h, session.id)).toEqual({ Bash: "denied" });
    expect(textOf(session.view.find((m) => m.role === "tool"))).toMatch(/^Denied/);
  });
});

describe("each permission mode's headline behaviour", () => {
  const expected: Record<PermissionMode, Record<string, "asked" | "denied" | "success">> = {
    default: { Write: "asked", Bash: "asked", Read: "success" },
    acceptEdits: { Write: "success", Bash: "asked", Read: "success" },
    plan: { Write: "denied", Bash: "asked", Read: "success" },
    dontAsk: { Write: "denied", Bash: "denied", Read: "success" },
    bypassPermissions: { Write: "success", Bash: "success", Read: "success" },
  };

  for (const mode of Object.keys(expected) as PermissionMode[]) {
    it(mode, async () => {
      h = await startHarness({
        files: { "notes.txt": "n\n" },
        script: [
          toolCalls([
            { name: "Write", arguments: { file_path: "w.txt", content: "w\n" } },
            { name: "Bash", arguments: { command: "touch b.txt" } },
            { name: "Read", arguments: { file_path: "notes.txt" } },
          ]),
          text("ok"),
        ],
      });
      const session = await h.engine.createSession({ cwd: h.project, mode });
      const seen = autoAnswer(h, session, () => ({ behavior: "deny" }));
      await session.run(ask("go"));
      const asked = new Set(seen.map((r) => r.toolName));
      const got: Record<string, string> = {};
      for (const [tool, outcome] of Object.entries(outcomes(h, session.id))) {
        got[tool] = asked.has(tool) ? "asked" : outcome;
      }
      expect(got).toEqual(expected[mode]);
    });
  }
});
