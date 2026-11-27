/** The browser fallback's workspace shows a project's memory folder after `/memory`, as main does. */
import { describe, expect, it } from "vitest";
import { createFakeWorkspace, fakeMemoryDirectory } from "./fake-workspace.ts";

const PROJECT = "/Users/you/code/tally";

describe("the fake workspace's memory root", () => {
  it("adds the folder it works out itself, with an empty MEMORY.md, only when asked", async () => {
    const { workspace } = createFakeWorkspace();
    const input = { sessionId: "s1", cwd: PROJECT, projectDir: PROJECT, additionalDirectories: [] };
    const plain = await workspace.track(input);
    expect(plain.memoryDirectory).toBeUndefined();
    const folder = fakeMemoryDirectory(PROJECT);
    expect(folder).toBe("/Users/you/.dawg/projects/-Users-you-code-tally/memory");
    await expect(workspace.listDirectory({ sessionId: "s1", path: folder })).rejects.toThrow();

    const info = await workspace.track({ ...input, memory: true });
    expect(info.memoryDirectory).toBe(folder);
    expect(
      await workspace.readFile({ sessionId: "s1", path: `${folder}/MEMORY.md` }),
    ).toMatchObject({ content: "" });
    await workspace.track(input);
    await expect(
      workspace.readFile({ sessionId: "s1", path: `${folder}/MEMORY.md` }),
    ).rejects.toThrow();
  });
});
