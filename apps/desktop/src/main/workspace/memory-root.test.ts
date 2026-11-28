/**
 * `/memory`'s root: tracking with `memory` adds the project's memory folder, found by main from
 * the project and the data root (the engine's `memoryDirectory`), as a read and write root of the
 * session's files. Without it the folder is outside the session, as before.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { memoryDirectory } from "@dawg/engine";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceService, type WorkspaceService } from "./service.ts";
import { createWorkspaceStore } from "./store.ts";
import { makeRepo, makeTempDir, removeTempDirs } from "./test-repo.ts";

const services: WorkspaceService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await removeTempDirs();
});

async function setup() {
  const dataRoot = await makeTempDir("dawg-data-");
  const service = createWorkspaceService({
    store: createWorkspaceStore(path.join(dataRoot, "workspace.json"), () => {}),
    log: () => {},
    watch: () => ({ close() {} }),
    memoryDirectory: (projectDir) => memoryDirectory(dataRoot, projectDir),
  });
  services.push(service);
  const repo = await makeRepo({ "a.txt": "one\n" });
  return { service, dataRoot, repo };
}

describe("the memory root", () => {
  it("is added, made and read and written like the session's folders, when asked for", async () => {
    const { service, dataRoot, repo } = await setup();
    const input = {
      sessionId: "s1",
      cwd: repo.dir,
      projectDir: repo.dir,
      additionalDirectories: [],
    };
    const plain = await service.track(input, "window");
    expect(plain.memoryDirectory).toBeUndefined();
    const folder = await memoryDirectory(dataRoot, repo.dir);
    await expect(service.listDirectory({ sessionId: "s1", path: folder })).rejects.toThrow();

    const info = await service.track({ ...input, memory: true }, "window");
    expect(info.memoryDirectory).toBe(folder);
    expect(folder.startsWith(path.join(dataRoot, "projects"))).toBe(true);
    expect((await stat(folder)).isDirectory()).toBe(true);
    const file = path.join(folder, "MEMORY.md");
    await service.writeFile({ sessionId: "s1", path: file, content: "- tabs, not spaces\n" });
    expect(await readFile(file, "utf8")).toBe("- tabs, not spaces\n");
    expect(await service.listDirectory({ sessionId: "s1", path: folder })).toEqual([
      expect.objectContaining({ name: "MEMORY.md", kind: "file" }),
    ]);
    expect(await service.readFile({ sessionId: "s1", path: file })).toMatchObject({
      binary: false,
      content: "- tabs, not spaces\n",
    });

    // Tracking without it again takes the root away.
    await service.track(input, "window");
    await expect(service.readFile({ sessionId: "s1", path: file })).rejects.toThrow();
  });

  it("is never a path a window sends: the track input has no field for it", async () => {
    const { service, repo } = await setup();
    const info = await service.track(
      {
        sessionId: "s1",
        cwd: repo.dir,
        projectDir: repo.dir,
        additionalDirectories: [],
        memory: true,
        // A window cannot name the folder; main works it out from the project.
        ...({ memoryDirectory: "/etc" } as object),
      },
      "window",
    );
    expect(info.memoryDirectory).not.toBe("/etc");
  });
});
