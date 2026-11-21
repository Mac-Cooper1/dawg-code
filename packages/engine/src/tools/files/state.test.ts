import { describe, expect, it } from "vitest";
import { createStateBag } from "../../testing/context.ts";
import { describeRanges, FileStateTracker, fileTracker, hashBytes } from "./state.ts";

const V1 = { hash: "h1", size: 10, mtimeMs: 1, totalLines: 100 };
const V2 = { hash: "h2", size: 12, mtimeMs: 2, totalLines: 100 };

describe("FileStateTracker", () => {
  it("merges ranges of one version and notices when they cover the file", () => {
    const tracker = new FileStateTracker();
    tracker.recordRead("/f", V1, { start: 1, end: 40 });
    tracker.recordRead("/f", V1, { start: 60, end: 100 });
    expect(tracker.get("/f")).toMatchObject({
      whole: false,
      ranges: [
        [1, 40],
        [60, 100],
      ],
    });
    tracker.recordRead("/f", V1, { start: 41, end: 59 });
    expect(tracker.get("/f")).toMatchObject({ whole: true, ranges: [[1, 100]] });
  });

  it("starts over when a different version is read", () => {
    const tracker = new FileStateTracker();
    tracker.recordRead("/f", V1, { start: 1, end: 100 });
    tracker.recordRead("/f", V2, { start: 1, end: 10 });
    expect(tracker.get("/f")).toMatchObject({ hash: "h2", whole: false, ranges: [[1, 10]] });
  });

  it("treats a view without lines as whole", () => {
    const tracker = new FileStateTracker();
    tracker.recordRead("/img.png", { ...V1, totalLines: 0 }, null);
    expect(tracker.get("/img.png")?.whole).toBe(true);
  });

  it("records its own writes", () => {
    const tracker = new FileStateTracker();
    tracker.recordWrite("/f", V2, "edit", false);
    expect(tracker.get("/f")).toMatchObject({ via: "edit", whole: false, ranges: [] });
    tracker.recordWrite("/f", V1, "write", true);
    expect(tracker.get("/f")).toMatchObject({ via: "write", whole: true, ranges: [[1, 100]] });
  });

  it("tells current, stale and unread apart by content hash", () => {
    const tracker = new FileStateTracker();
    expect(tracker.freshness("/f", "h1")).toEqual({ status: "unread" });
    tracker.recordRead("/f", V1, { start: 1, end: 5 });
    expect(tracker.freshness("/f", "h1").status).toBe("current");
    expect(tracker.freshness("/f", "h2").status).toBe("stale");
    tracker.forget("/f");
    expect(tracker.freshness("/f", "h1").status).toBe("unread");
  });

  it("lists the most recently seen first", () => {
    let now = 0;
    const tracker = new FileStateTracker(() => ++now);
    tracker.recordRead("/a", V1, null);
    tracker.recordRead("/b", V1, null);
    tracker.recordRead("/a", V1, null);
    expect(tracker.list().map((r) => r.path)).toEqual(["/a", "/b"]);
  });

  it("lives in the session state bag", () => {
    const bag = createStateBag();
    expect(fileTracker(bag)).toBe(fileTracker(bag));
  });
});

describe("helpers", () => {
  it("describes ranges", () => {
    expect(describeRanges([[1, 2000]])).toBe("lines 1-2000");
    expect(describeRanges([[7, 7]])).toBe("line 7");
    expect(
      describeRanges([
        [1, 10],
        [20, 20],
        [30, 40],
      ]),
    ).toBe("lines 1-10, 20 and 30-40");
  });

  it("hashes bytes", () => {
    expect(hashBytes(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
