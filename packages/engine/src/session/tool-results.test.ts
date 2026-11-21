import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TempStore, tempStore } from "./__fixtures__/script.ts";
import { safeOutputName, saveToolOutput } from "./tool-results.ts";

let t: TempStore;

beforeEach(async () => {
  t = await tempStore();
});
afterEach(async () => {
  await t.cleanup();
});

describe("safe output names", () => {
  it.each([
    ["bash-output.txt", "bash-output.txt"],
    ["../../etc/passwd", "passwd"],
    ["..\\..\\windows\\system.ini", "system.ini"],
    [".hidden", "hidden"],
    ["..", "output"],
    ["", "output"],
    ["a b/c d.txt", "c_d.txt"],
    ["résumé.md", "resume.md"],
    ["日本語.txt", "txt"],
    ["out\u0000put.log", "out_put.log"],
  ])("%j becomes %j", (input, expected) => {
    expect(safeOutputName(input)).toBe(expected);
  });

  it("are cut to 100 characters, keeping the extension", () => {
    const name = safeOutputName(`${"x".repeat(300)}.json`);
    expect(name.length).toBe(100);
    expect(name.endsWith(".json")).toBe(true);
  });
});

describe("saving tool output", () => {
  it("writes under the session's tool-results folder and returns the absolute path", async () => {
    const w = await t.store.create({ cwd: t.project });
    const file = await w.saveOutput("../escape.txt", "hello");
    expect(path.isAbsolute(file)).toBe(true);
    expect(file).toBe(path.join(w.toolResultsDir, "escape.txt"));
    expect(await readFile(file, "utf8")).toBe("hello");
    await w.close();
    await expect(w.saveOutput("late.txt", "x")).rejects.toMatchObject({ code: "closed" });
  });

  it("never overwrites: repeated and concurrent names get numbered", async () => {
    const dir = path.join(t.root, "results");
    const first = await saveToolOutput(dir, "out.txt", "1");
    const rest = await Promise.all(
      Array.from({ length: 5 }, (_, i) => saveToolOutput(dir, "out.txt", String(i + 2))),
    );
    expect(path.basename(first)).toBe("out.txt");
    expect(rest.map((p) => path.basename(p)).sort()).toStrictEqual(
      ["out-2.txt", "out-3.txt", "out-4.txt", "out-5.txt", "out-6.txt"].sort(),
    );
    const contents = await Promise.all([first, ...rest].map((p) => readFile(p, "utf8")));
    expect(contents.sort()).toStrictEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("writes bytes as given", async () => {
    const bytes = new Uint8Array([0, 255, 10, 13, 128]);
    const file = await saveToolOutput(path.join(t.root, "bin"), "blob.bin", bytes);
    expect(new Uint8Array(await readFile(file))).toStrictEqual(bytes);
  });
});
