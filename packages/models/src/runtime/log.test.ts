import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LineSplitter, REDACTED, RotatingLog } from "./log.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dawg-log-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("RotatingLog", () => {
  test("rotates at the size cap and keeps a fixed number of files", async () => {
    const path = join(dir, "runtime.log");
    const log = new RotatingLog(path, { maxBytes: 1000, files: 2 });
    for (let i = 0; i < 100; i++)
      log.writeLine(`line ${String(i).padStart(3, "0")} ${"x".repeat(40)}`);
    log.close();
    expect((await readdir(dir)).sort()).toEqual(["runtime.log", "runtime.log.1", "runtime.log.2"]);
    for (const f of ["runtime.log", "runtime.log.1", "runtime.log.2"]) {
      expect((await stat(join(dir, f))).size).toBeLessThanOrEqual(1000);
    }
    // Newest lines are in the current file, older ones in .1, and the oldest were dropped.
    expect(await readFile(path, "utf8")).toContain("line 099");
    expect(await readFile(`${path}.1`, "utf8")).not.toContain("line 099");
    const all = (
      await Promise.all([path, `${path}.1`, `${path}.2`].map((p) => readFile(p, "utf8")))
    ).join("");
    expect(all).not.toContain("line 000");
  });

  test("appends across instances and is private to the user", async () => {
    const path = join(dir, "a.log");
    new RotatingLog(path, { maxBytes: 10_000, files: 1 }).writeLine("one");
    const second = new RotatingLog(path, { maxBytes: 10_000, files: 1 });
    second.writeLine("two");
    second.close();
    expect(await readFile(path, "utf8")).toBe("one\ntwo\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("redacts secrets in the file and the tail", async () => {
    const path = join(dir, "r.log");
    const log = new RotatingLog(path, { maxBytes: 10_000, files: 1 });
    log.setSecrets(["s3cr3t-key"]);
    log.writeLine("auth s3cr3t-key and again s3cr3t-key");
    log.close();
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("s3cr3t-key");
    expect(text).toContain(`auth ${REDACTED} and again ${REDACTED}`);
    expect(log.tail()).not.toContain("s3cr3t-key");
  });

  test("tail returns the last lines", () => {
    const log = new RotatingLog(join(dir, "t.log"), { maxBytes: 10_000, files: 1, tailLines: 3 });
    for (const l of ["a", "b", "c", "d"]) log.writeLine(l);
    log.close();
    expect(log.tail()).toBe("b\nc\nd");
    expect(log.tail(1)).toBe("d");
  });
});

describe("LineSplitter", () => {
  test("reassembles lines split across chunks, so a secret is never cut in half", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((l) => lines.push(l));
    splitter.push(Buffer.from("key is abc"));
    splitter.push(Buffer.from("def\r\nnext"));
    splitter.push("\n");
    splitter.push("tail without newline");
    splitter.flush();
    expect(lines).toEqual(["key is abcdef", "next", "tail without newline"]);
  });
});
