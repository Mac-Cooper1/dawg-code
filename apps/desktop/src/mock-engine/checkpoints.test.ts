/** Checkpoints and rewind in the mock engine, answered as the real engine answers them. */
import { ErrorCodes } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { checkConformance } from "./conformance.ts";
import { all, type Harness, harness } from "./test-support.ts";

let h: Harness;
afterEach(() => h?.engine.dispose());

async function opened() {
  h = harness({ speed: Number.POSITIVE_INFINITY, startPlayback: "created" });
  await h.runAll();
  const peer = await h.connect();
  await peer.request("session.resume", { sessionId: "fix-split" });
  return peer;
}

describe("checkpoints", () => {
  it("lists one per prompt with the files its edits changed", async () => {
    const peer = await opened();
    const { checkpoints, retention } = await peer.request("session.checkpoints", {
      sessionId: "fix-split",
    });
    expect(retention).toBe(100);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints.every((c) => c.tracked && c.prompt !== "")).toBe(true);
    const edited = checkpoints.flatMap((c) => c.files.map((f) => f.path));
    expect(edited.length).toBeGreaterThan(0);
    // Restoring to the first puts back everything any turn changed.
    expect(checkpoints[0]?.restore.map((s) => s.path).sort()).toEqual([...new Set(edited)].sort());
  });

  it("rewinds the conversation into a fork from before the prompt, files reported", async () => {
    const peer = await opened();
    const { checkpoints } = await peer.request("session.checkpoints", { sessionId: "fix-split" });
    const second = checkpoints[1];
    const result = await peer.request("session.rewind", {
      sessionId: "fix-split",
      checkpointId: second?.id ?? "",
      action: "both",
    });
    expect(result.outcome).toBe("done");
    expect(result.prompt).toBe(second?.prompt);
    expect(result.files?.restored.length).toBeGreaterThanOrEqual(0);
    expect(result.session?.session).toMatchObject({
      title: "Fix the failing split test (rewound)",
      forkedFrom: {
        sessionId: "fix-split",
        point: { position: "beforeTurn", turnId: second?.turnId },
      },
    });
    const fork = result.session?.session.id ?? "";
    const copied = await peer.request("session.replay", { sessionId: fork, afterSeq: 0 });
    expect(all(copied.events, "turn.started")).toHaveLength(1);
    expect(checkConformance(copied.events)).toEqual([]);
  });

  it("restores files alone, summarises from a point, and refuses an unknown checkpoint", async () => {
    const peer = await opened();
    const { checkpoints } = await peer.request("session.checkpoints", { sessionId: "fix-split" });
    const files = await peer.request("session.rewind", {
      sessionId: "fix-split",
      checkpointId: checkpoints[0]?.id ?? "",
      action: "files",
    });
    expect(files).toMatchObject({ outcome: "done", session: null, prompt: null });
    const summary = await peer.request("session.rewind", {
      sessionId: "fix-split",
      checkpointId: checkpoints[1]?.id ?? "",
      action: "summarize",
      instructions: "the rounding",
    });
    expect(summary.prompt).toBe(checkpoints[1]?.prompt);
    const started = all(peer.of("fix-split"), "compaction.started").at(-1);
    expect(started?.payload.focus).toBe("the rounding");
    await h.runAll();
    const error = await peer.failure("session.rewind", {
      sessionId: "fix-split",
      checkpointId: "nope",
      action: "files",
    });
    expect(error.code).toBe(ErrorCodes.InvalidParams);
  });

  it("answers /rewind and /memory with their lists", async () => {
    const peer = await opened();
    const rewind = await peer.request("session.command", {
      sessionId: "fix-split",
      name: "rewind",
    });
    expect(rewind.output).toContain("Checkpoints, newest first:");
    const memory = await peer.request("session.command", {
      sessionId: "fix-split",
      name: "memory",
    });
    expect(memory.output).toContain("MEMORY.md");
  });
});
