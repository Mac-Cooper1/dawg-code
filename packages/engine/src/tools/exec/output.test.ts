import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cutAtCodePoint, OutputCollector } from "./output.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dawg-output-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fileCreator() {
  const created: string[] = [];
  return {
    created,
    createFile: async (initial: string) => {
      const file = path.join(dir, `out-${created.length}.txt`);
      await writeFile(file, initial);
      created.push(file);
      return file;
    },
  };
}

describe("OutputCollector", () => {
  it("keeps short output whole and creates no file", async () => {
    const files = fileCreator();
    const collector = new OutputCollector({
      maxChars: 100,
      fileCapBytes: 1000,
      createFile: files.createFile,
    });
    collector.push("hello ");
    collector.push("world\n");
    const out = await collector.finish();
    expect(out).toMatchObject({ text: "hello world\n", truncated: false, outputPath: null });
    expect(files.created).toEqual([]);
  });

  it("cuts long output to head and tail and saves all of it", async () => {
    const files = fileCreator();
    const collector = new OutputCollector({
      maxChars: 100,
      fileCapBytes: 1_000_000,
      createFile: files.createFile,
    });
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}\n`);
    for (const line of lines) collector.push(line);
    const out = await collector.finish();
    expect(out.truncated).toBe(true);
    expect(out.totalChars).toBe(lines.join("").length);
    expect(out.text.startsWith("line 0\nline 1\n")).toBe(true);
    expect(out.text.endsWith("line 1999\n")).toBe(true);
    expect(out.text).toMatch(/\[\.\.\. [\d,]+ characters omitted \.\.\.\]/);
    expect(out.text.length).toBeLessThan(200);
    expect(out.outputPath).toBe(files.created[0]);
    expect(await readFile(out.outputPath ?? "", "utf8")).toBe(lines.join(""));
  });

  it("stops saving at the file cap and says so in the file", async () => {
    const files = fileCreator();
    const collector = new OutputCollector({
      maxChars: 10,
      fileCapBytes: 50,
      createFile: files.createFile,
    });
    for (let i = 0; i < 100; i++) collector.push("0123456789");
    const out = await collector.finish();
    expect(out.fileTruncated).toBe(true);
    const saved = await readFile(out.outputPath ?? "", "utf8");
    expect(saved.startsWith("0123456789".repeat(5))).toBe(true);
    expect(saved).toContain("not saved");
    expect(saved.length).toBeLessThan(200);
  });

  it("writes everything to a given file from the start", async () => {
    const file = path.join(dir, "background.txt");
    await writeFile(file, "");
    const collector = new OutputCollector({ maxChars: 20, fileCapBytes: 1000, filePath: file });
    collector.push("short\n");
    expect(collector.recentText(100)).toBe("short\n");
    collector.push("x".repeat(100));
    const out = await collector.finish();
    expect(await readFile(file, "utf8")).toBe(`short\n${"x".repeat(100)}`);
    expect(out.outputPath).toBe(file);
  });

  it("calls the limit callback once when the byte limit is passed", async () => {
    let calls = 0;
    const collector = new OutputCollector({
      maxChars: 10,
      fileCapBytes: 0,
      limitBytes: 25,
      onLimit: () => {
        calls += 1;
      },
    });
    for (let i = 0; i < 10; i++) collector.push("0123456789");
    await collector.finish();
    expect(calls).toBe(1);
  });

  it("pauses the producer while the file is being created", async () => {
    const events: string[] = [];
    let release: (() => void) | undefined;
    const collector = new OutputCollector({
      maxChars: 5,
      fileCapBytes: 1000,
      createFile: async (initial) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        const file = path.join(dir, "slow.txt");
        await writeFile(file, initial);
        return file;
      },
      pause: () => events.push("pause"),
      resume: () => events.push("resume"),
    });
    collector.push("0123456789");
    expect(events).toEqual(["pause"]);
    collector.push("abc");
    release?.();
    const out = await collector.finish();
    expect(events).toEqual(["pause", "resume"]);
    expect(await readFile(out.outputPath ?? "", "utf8")).toBe("0123456789abc");
  });
});

describe("cutAtCodePoint", () => {
  it("never splits a surrogate pair", () => {
    expect(cutAtCodePoint("ab🙂cd", 3)).toBe("ab");
    expect(cutAtCodePoint("ab🙂cd", 4)).toBe("ab🙂");
  });
});
