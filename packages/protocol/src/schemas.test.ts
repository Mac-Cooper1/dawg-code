import { describe, expect, test } from "vitest";
import { eventSamples, methodSamples, usage } from "./__fixtures__/samples.ts";
import { ErrorInfoSchema, PromptSchema } from "./common.ts";
import { EVENT_NAMES, type EventName, events, parseEvent } from "./events.ts";
import { METHOD_NAMES, methods } from "./methods.ts";

/** The `sessionId`, `seq` and `time` of an event's sample. */
function baseOf(name: EventName) {
  const { sessionId, seq, time } = eventSamples[name].payload;
  return { sessionId, seq, time };
}

describe("methods", () => {
  test.each(METHOD_NAMES)("%s accepts valid params and results and rejects bad ones", (name) => {
    const definition = methods[name];
    const sample = methodSamples[name];
    expect(definition.params.safeParse(sample.params).error).toBeUndefined();
    expect(definition.result.safeParse(sample.result).error).toBeUndefined();
    expect(definition.params.safeParse(sample.badParams).success).toBe(false);
    expect(definition.result.safeParse(sample.badResult).success).toBe(false);
  });

  test("unknown fields are stripped, not rejected", () => {
    const parsed = methods["session.prompt"].params.parse({
      sessionId: "s1",
      prompt: { content: [{ type: "text", text: "hi", future: 1 }], future: true },
      future: "field",
    });
    expect(parsed).toEqual({
      sessionId: "s1",
      prompt: { content: [{ type: "text", text: "hi" }], mentions: [] },
    });
  });

  test("defaults are filled for handlers", () => {
    const init = methods.initialize.params.parse({
      protocolVersion: 1,
      client: { name: "cli", version: "1" },
    });
    expect(init.capabilities).toEqual({
      permissionPrompts: true,
      questions: true,
      planApproval: true,
      elicitation: true,
    });
    const command = methods["session.command"].params.parse({ sessionId: "s1", name: "help" });
    expect(command.args).toBe("");
  });

  test("replay results drop unknown events and keep known ones typed", () => {
    const parsed = methods["session.replay"].result.parse({
      events: [
        { event: "future.event", payload: { anything: true } },
        { event: "message.delta", payload: eventSamples["message.delta"].payload },
      ],
      lastSeq: 2,
      hasMore: false,
    });
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.event).toBe("message.delta");
  });

  test("replay results reject a known event with a bad payload, naming where", () => {
    const parsed = methods["session.replay"].result.safeParse(
      methodSamples["session.replay"].badResult,
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path.slice(0, 3)).toEqual(["events", 0, "payload"]);
  });
});

describe("events", () => {
  test.each(EVENT_NAMES)("%s accepts a valid payload and rejects a bad one", (name) => {
    const schema = events[name];
    const sample = eventSamples[name];
    expect(schema.safeParse(sample.payload).error).toBeUndefined();
    expect(schema.safeParse(sample.bad).success).toBe(false);
  });

  test.each(EVENT_NAMES)("%s requires sessionId and a positive seq", (name) => {
    const payload = eventSamples[name].payload as Record<string, unknown>;
    const { sessionId: _sessionId, ...withoutSession } = payload;
    expect(events[name].safeParse(withoutSession).success).toBe(false);
    expect(events[name].safeParse({ ...payload, seq: 0 }).success).toBe(false);
    expect(events[name].safeParse({ ...payload, seq: 1.5 }).success).toBe(false);
  });

  test("parseEvent reports unknown names without throwing", () => {
    expect(parseEvent("nope", {})).toEqual({ ok: false, reason: "unknown", name: "nope" });
    const bad = parseEvent("message.delta", { text: 1 });
    expect(bad.ok).toBe(false);
    const good = parseEvent("message.delta", eventSamples["message.delta"].payload);
    expect(good.ok && good.event.event).toBe("message.delta");
  });

  test("error kinds a newer engine adds arrive as other", () => {
    const info = ErrorInfoSchema.parse({
      kind: "gpu_on_fire",
      message: "x",
      detail: null,
      retryable: false,
    });
    expect(info.kind).toBe("other");
  });

  test("events stored before a field was added still parse, with the field's default", () => {
    const status = events["session.status"].parse({
      ...eventSamples["session.status"].payload,
      queuePosition: undefined,
    });
    expect(status.queuePosition).toBeNull();

    const { compactAt: _compactAt, breakdown: _breakdown, ...oldUsage } = usage;
    const parsedUsage = events["usage.updated"].parse({
      ...baseOf("usage.updated"),
      usage: oldUsage,
    });
    expect(parsedUsage.usage.compactAt).toBeNull();
    expect(parsedUsage.usage.breakdown).toBeNull();

    const plan = events["plan.proposed"].parse(eventSamples["plan.proposed"].payload);
    expect(plan.modeBeforePlan).toBeNull();

    const finished = events["tool.finished"].parse({
      ...baseOf("tool.finished"),
      turnId: "t1",
      toolCallId: "c1",
      toolName: "Bash",
      outcome: "error",
      content: [{ type: "text", text: "Error: boom\n\nExit code 1" }],
      display: {
        kind: "command",
        command: "make",
        cwd: "/tmp/project",
        exitCode: 1,
        durationMs: 12,
        timedOut: false,
        interrupted: false,
        backgroundTaskId: null,
        outputPath: null,
      },
      durationMs: 12,
    });
    expect(finished.display?.kind === "command" && finished.display.output).toBeNull();
    expect(finished.display?.kind === "command" && finished.display.notes).toEqual([]);
  });

  test("a queued session reports its place in line", () => {
    const parsed = events["session.status"].parse({
      ...baseOf("session.status"),
      status: "working",
      waitingOn: null,
      message: "Waiting for the model",
      queuePosition: 2,
    });
    expect(parsed.queuePosition).toBe(2);
    expect(events["session.status"].safeParse({ ...parsed, queuePosition: 0 }).success).toBe(false);
  });

  test("payloads survive a JSON round trip unchanged", () => {
    for (const name of EVENT_NAMES) {
      const parsed = events[name].parse(eventSamples[name].payload);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
    }
  });
});

describe("prompt", () => {
  test("needs at least one content part", () => {
    expect(PromptSchema.safeParse({ content: [] }).success).toBe(false);
  });
});
