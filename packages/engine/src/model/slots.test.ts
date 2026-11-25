import { describe, expect, it } from "vitest";
import {
  type ModelClient,
  ModelError,
  type ModelRequest,
  type ModelStreamEvent,
} from "../contracts/model.ts";
import { SlotScheduler, scheduledClient } from "./slots.ts";

/** Lets pending promise callbacks run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("SlotScheduler", () => {
  it("hands out free slots at once and queues requests first come, first served", async () => {
    const scheduler = new SlotScheduler([0]);
    const first = await scheduler.acquire({ owner: "a" });
    expect(first.slot).toBe(0);
    const order: string[] = [];
    const positions: Record<string, number[]> = { b: [], c: [] };
    const b = scheduler
      .acquire({ owner: "b", onQueue: (p) => positions.b?.push(p) })
      .then((lease) => {
        order.push("b");
        return lease;
      });
    const c = scheduler
      .acquire({ owner: "c", onQueue: (p) => positions.c?.push(p) })
      .then((lease) => {
        order.push("c");
        return lease;
      });
    expect(scheduler.waiting).toBe(2);
    expect(positions).toEqual({ b: [1], c: [2] });

    first.release();
    const second = await b;
    expect(second.slot).toBe(0);
    // c moved up when b was served.
    expect(positions).toEqual({ b: [1], c: [2, 1] });
    second.release();
    (await c).release();
    expect(order).toEqual(["b", "c"]);
    expect(scheduler.inUse).toBe(0);
    expect(scheduler.waiting).toBe(0);
  });

  it("gives an owner the slot it used last, else the free slot used longest ago", async () => {
    const scheduler = new SlotScheduler([0, 1, 2]);
    const a = await scheduler.acquire({ owner: "a" });
    const b = await scheduler.acquire({ owner: "b" });
    expect([a.slot, b.slot]).toEqual([0, 1]);
    b.release();
    a.release();
    // c has used none: a slot nobody has used comes first.
    const c = await scheduler.acquire({ owner: "c" });
    expect(c.slot).toBe(2);
    c.release();
    expect((await scheduler.acquire({ owner: "b" })).slot).toBe(1);
    expect((await scheduler.acquire({ owner: "a" })).slot).toBe(0);

    const two = new SlotScheduler([0, 1]);
    (await two.acquire({ owner: "x" })).release();
    (await two.acquire({ owner: "y" })).release();
    // y's slot is free, so y gets it back; the other one was used longer ago, so z gets that.
    (await two.acquire({ owner: "y" })).release();
    expect((await two.acquire({ owner: "z" })).slot).toBe(0);
  });

  it("serves the first in line with whatever slot frees, preferred or not", async () => {
    const scheduler = new SlotScheduler([0, 1]);
    (await scheduler.acquire({ owner: "c" })).release();
    const a = await scheduler.acquire({ owner: "a" });
    const b = await scheduler.acquire({ owner: "b" });
    expect([a.slot, b.slot]).toEqual([1, 0]);
    // c used slot 0 before; slot 1 frees first, and c takes it rather than wait.
    const c = scheduler.acquire({ owner: "c" });
    a.release();
    expect((await c).slot).toBe(1);
  });

  it("stops a wait at once when its signal aborts, and the others move up", async () => {
    const scheduler = new SlotScheduler([0]);
    const held = await scheduler.acquire({ owner: "a" });
    const controller = new AbortController();
    const cPositions: number[] = [];
    const b = scheduler.acquire({ owner: "b", signal: controller.signal });
    const c = scheduler.acquire({ owner: "c", onQueue: (p) => cPositions.push(p) });
    controller.abort();
    await expect(b).rejects.toMatchObject({ name: "ModelError", kind: "aborted" });
    expect(scheduler.waiting).toBe(1);
    expect(cPositions).toEqual([2, 1]);
    held.release();
    expect((await c).slot).toBe(0);

    const already = new AbortController();
    already.abort();
    await expect(scheduler.acquire({ owner: "d", signal: already.signal })).rejects.toBeInstanceOf(
      ModelError,
    );
  });

  it("ignores a second release", async () => {
    const scheduler = new SlotScheduler([0, 1]);
    const a = await scheduler.acquire({ owner: "a" });
    const b = await scheduler.acquire({ owner: "b" });
    a.release();
    a.release();
    expect(scheduler.inUse).toBe(1);
    b.release();
    expect(scheduler.inUse).toBe(0);
    expect(() => new SlotScheduler([])).toThrow();
  });
});

/** A client whose streams are driven by the test: each request waits for `next()`. */
function fakeClient() {
  const sent: ModelRequest[] = [];
  const gates: (() => void)[] = [];
  const fail = new Set<number>();
  const client: ModelClient = {
    endpoint: { model: "fake" } as ModelClient["endpoint"],
    async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
      const index = sent.length;
      sent.push(request);
      yield { type: "text_delta", text: "x" };
      await new Promise<void>((resolve, reject) => {
        gates.push(resolve);
        request.signal?.addEventListener("abort", () =>
          reject(new ModelError("aborted", "aborted")),
        );
      });
      if (fail.has(index)) throw new ModelError("http", "failed on purpose");
      yield {
        type: "finished",
        reply: {
          content: "x",
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
          usage: {
            promptTokens: null,
            completionTokens: null,
            cachedTokens: null,
            promptTokensPerSecond: null,
            completionTokensPerSecond: null,
            promptMs: null,
            completionMs: null,
          },
          model: null,
        },
      };
    },
    countTokens: async () => 7,
  };
  return { client, sent, gates, fail };
}

async function drain(stream: AsyncIterable<ModelStreamEvent>): Promise<string> {
  try {
    for await (const _ of stream) {
      // Read to the end.
    }
    return "finished";
  } catch (error) {
    return error instanceof ModelError ? error.kind : "other";
  }
}

describe("scheduledClient", () => {
  it("sends each request on its slot and gives the slot back however the stream ends", async () => {
    const scheduler = new SlotScheduler([3]);
    const fake = fakeClient();
    const queued: (number | null)[] = [];
    const a = scheduledClient(fake.client, scheduler, { owner: "a" });
    const b = scheduledClient(fake.client, scheduler, {
      owner: "b",
      onQueue: (p) => queued.push(p),
    });
    expect(a.endpoint.model).toBe("fake");
    expect(await a.countTokens({ messages: [], tools: [] })).toBe(7);

    // Success: a holds the slot until its stream ends; b waits, then runs.
    fake.fail.add(1);
    const first = drain(a.stream({ messages: [], tools: [], slot: 9 }));
    await tick();
    const second = drain(b.stream({ messages: [], tools: [] }));
    await tick();
    expect(fake.sent).toHaveLength(1);
    expect(queued).toEqual([1]);
    fake.gates.shift()?.();
    expect(await first).toBe("finished");
    await tick();
    expect(queued).toEqual([1, null]);
    expect(fake.sent.map((r) => r.slot)).toEqual([3, 3]);

    // Error: b's stream fails, and the slot is free again.
    fake.gates.shift()?.();
    expect(await second).toBe("http");
    expect(scheduler.inUse).toBe(0);

    // Abort while streaming.
    const controller = new AbortController();
    const third = drain(a.stream({ messages: [], tools: [], signal: controller.signal }));
    await tick();
    expect(scheduler.inUse).toBe(1);
    controller.abort();
    expect(await third).toBe("aborted");
    expect(scheduler.inUse).toBe(0);

    // The reader stops early.
    const iterator = a.stream({ messages: [], tools: [] })[Symbol.asyncIterator]();
    await iterator.next();
    expect(scheduler.inUse).toBe(1);
    await iterator.return?.();
    expect(scheduler.inUse).toBe(0);
    fake.gates.splice(0);
  });

  it("an aborted wait sends nothing and holds no slot", async () => {
    const scheduler = new SlotScheduler([0]);
    const fake = fakeClient();
    const held = await scheduler.acquire({ owner: "x" });
    const queued: (number | null)[] = [];
    const client = scheduledClient(fake.client, scheduler, {
      owner: "a",
      onQueue: (p) => queued.push(p),
    });
    const controller = new AbortController();
    const waiting = drain(client.stream({ messages: [], tools: [], signal: controller.signal }));
    await tick();
    expect(queued).toEqual([1]);
    controller.abort();
    expect(await waiting).toBe("aborted");
    expect(queued).toEqual([1, null]);
    expect(fake.sent).toHaveLength(0);
    expect(scheduler.waiting).toBe(0);
    held.release();
    expect(scheduler.inUse).toBe(0);
  });
});
