import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveRuntimeBinary } from "./resolve.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dawg-resolve-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function executable(path: string, mode = 0o755): Promise<string> {
  await writeFile(path, "#!/bin/sh\n");
  await chmod(path, mode);
  return path;
}

describe("resolveRuntimeBinary", () => {
  test("DAWG_RUNTIME_BIN wins over the bundled build", async () => {
    const custom = await executable(join(dir, "my-llama-server"));
    await mkdir(join(dir, "runtime", "arm64"), { recursive: true });
    await executable(join(dir, "runtime", "arm64", "llama-server"));
    const resolved = await resolveRuntimeBinary({
      env: { DAWG_RUNTIME_BIN: custom },
      arch: "arm64",
      runtimeDir: join(dir, "runtime"),
    });
    expect(resolved).toEqual({ binary: custom, source: "env", arch: "arm64" });
  });

  test("falls back to the bundled build for the machine's architecture", async () => {
    await mkdir(join(dir, "runtime", "x64"), { recursive: true });
    const bundled = await executable(join(dir, "runtime", "x64", "llama-server"));
    expect(
      await resolveRuntimeBinary({ env: {}, arch: "x64", runtimeDir: join(dir, "runtime") }),
    ).toEqual({
      binary: bundled,
      source: "bundled",
      arch: "x64",
    });
  });

  test("explains how to fetch the runtime when nothing is there", async () => {
    await expect(
      resolveRuntimeBinary({ env: {}, arch: "arm64", runtimeDir: join(dir, "runtime") }),
    ).rejects.toMatchObject({
      code: "not-found",
      message: expect.stringContaining("fetch-runtime"),
    });
  });

  test("rejects a relative or non-executable override", async () => {
    await expect(
      resolveRuntimeBinary({ env: { DAWG_RUNTIME_BIN: "llama-server" } }),
    ).rejects.toMatchObject({
      code: "not-found",
    });
    const notExecutable = await executable(join(dir, "plain"), 0o644);
    await expect(
      resolveRuntimeBinary({ env: { DAWG_RUNTIME_BIN: notExecutable } }),
    ).rejects.toMatchObject({
      code: "not-found",
    });
  });
});
