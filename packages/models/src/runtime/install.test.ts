import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildMachO, CPU_ARM64, CPU_X86_64 } from "./__fixtures__/macho-builder.ts";
import { ChecksumMismatchError } from "./errors.ts";
import {
  ensureTestModel,
  installRuntime,
  MANIFEST_NAME,
  verifyInstalledRuntime,
} from "./install.ts";
import { type RuntimeLock, readRuntimeLock } from "./lock.ts";

const execFileAsync = promisify(execFile);

let dir: string;
let server: Server;
let baseUrl: string;
const served = new Map<string, Buffer>();
let requests: string[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dawg-install-test-"));
  requests = [];
  served.clear();
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    const body = served.get(req.url ?? "");
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-length": body.length }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

interface ArchiveOptions {
  cpuType?: number;
  dropLibrary?: boolean;
  dropLicense?: boolean;
}

/** A tarball shaped like llama.cpp's macOS release archives. */
async function makeArchive(
  name: string,
  options: ArchiveOptions = {},
): Promise<{ sha256: string; size: number }> {
  const cpuType = options.cpuType ?? CPU_X86_64;
  const root = join(dir, `src-${name}`);
  const top = join(root, "llama-bTEST");
  await mkdir(top, { recursive: true });
  await writeFile(
    join(top, "llama-server"),
    buildMachO({
      cpuType,
      dylibs: [
        { name: "@rpath/libllama.1.dylib" },
        { name: "@rpath/libggml.1.dylib" },
        { name: "@rpath/libnot-shipped.dylib", weak: true },
        { name: "/usr/lib/libSystem.B.dylib" },
      ],
      rpaths: ["@loader_path"],
    }),
    { mode: 0o755 },
  );
  await writeFile(
    join(top, "libllama.1.0.0.dylib"),
    buildMachO({ cpuType, dylibs: [{ name: "@rpath/libggml.1.dylib" }] }),
  );
  await symlink("libllama.1.0.0.dylib", join(top, "libllama.1.dylib"));
  await symlink("libllama.1.dylib", join(top, "libllama.dylib"));
  if (!options.dropLibrary) {
    await writeFile(join(top, "libggml.1.0.0.dylib"), buildMachO({ cpuType }));
    await symlink("libggml.1.0.0.dylib", join(top, "libggml.1.dylib"));
  }
  await writeFile(join(top, "libunrelated.dylib"), buildMachO({ cpuType }));
  await writeFile(join(top, "llama-cli"), buildMachO({ cpuType }), { mode: 0o755 });
  if (!options.dropLicense) await writeFile(join(top, "LICENSE"), "MIT License\n");
  const archive = join(dir, name);
  await execFileAsync("tar", ["-czf", archive, "-C", root, "llama-bTEST"]);
  const bytes = await readFile(archive);
  served.set(`/${name}`, bytes);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

function lockFor(name: string, archive: { sha256: string; size: number }): RuntimeLock {
  const entry = {
    name,
    url: `${baseUrl}/${name}`,
    sizeBytes: archive.size,
    sha256: archive.sha256,
  };
  return {
    llamaCpp: {
      repo: "ggml-org/llama.cpp",
      tag: "b1",
      commit: "0".repeat(40),
      publishedAt: "2026-01-01T00:00:00Z",
      archives: { x64: entry, arm64: entry },
    },
    testModel: {
      repo: "o/r",
      revision: "0".repeat(40),
      file: "m.gguf",
      url: `${baseUrl}/m.gguf`,
      sizeBytes: 5,
      sha256: createHash("sha256").update("model").digest("hex"),
      licence: "Apache-2.0",
    },
  };
}

describe("installRuntime", () => {
  test("installs llama-server, exactly the libraries it loads, and the licence", async () => {
    const archive = await makeArchive("llama-bTEST-bin-macos-x64.tar.gz");
    const runtimeDir = join(dir, "runtime");
    const result = await installRuntime({
      arch: "x64",
      lock: lockFor("llama-bTEST-bin-macos-x64.tar.gz", archive),
      runtimeDir,
      tmpDir: dir,
    });
    expect(result.action).toBe("installed");
    const target = join(runtimeDir, "x64");
    expect((await readdir(target)).sort()).toEqual([
      "LICENSE",
      "libggml.1.0.0.dylib",
      "libggml.1.dylib",
      "libllama.1.0.0.dylib",
      "libllama.1.dylib",
      "llama-server",
      MANIFEST_NAME,
    ]);
    expect(await readlink(join(target, "libllama.1.dylib"))).toBe("libllama.1.0.0.dylib");
    expect((await stat(join(target, "llama-server"))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(target, "LICENSE"), "utf8")).toBe("MIT License\n");
    // Scratch space is cleaned up: only the source tree, the archive and the result remain.
    expect((await readdir(dir)).filter((n) => n.startsWith("dawg-runtime-"))).toEqual([]);
    expect((await readdir(runtimeDir)).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("is a no-op when already present and verified, and repairs tampering", async () => {
    const archive = await makeArchive("a.tar.gz");
    const lock = lockFor("a.tar.gz", archive);
    const runtimeDir = join(dir, "runtime");
    await installRuntime({ arch: "x64", lock, runtimeDir, tmpDir: dir });
    expect(requests).toEqual(["/a.tar.gz"]);

    const again = await installRuntime({ arch: "x64", lock, runtimeDir, tmpDir: dir });
    expect(again.action).toBe("already-present");
    expect(requests).toEqual(["/a.tar.gz"]);

    await writeFile(join(runtimeDir, "x64", "libggml.1.0.0.dylib"), "tampered");
    const verify = await verifyInstalledRuntime(join(runtimeDir, "x64"), {
      tag: "b1",
      arch: "x64",
      archive: { name: "a.tar.gz", sha256: archive.sha256 },
    });
    expect(verify).toEqual({ ok: false, reason: "libggml.1.0.0.dylib changed" });
    const repaired = await installRuntime({ arch: "x64", lock, runtimeDir, tmpDir: dir });
    expect(repaired.action).toBe("installed");
    expect(requests).toHaveLength(2);
  });

  test("a different pin in the lock file triggers a reinstall", async () => {
    const first = await makeArchive("a.tar.gz");
    const runtimeDir = join(dir, "runtime");
    await installRuntime({
      arch: "x64",
      lock: lockFor("a.tar.gz", first),
      runtimeDir,
      tmpDir: dir,
    });
    const second = await makeArchive("b.tar.gz");
    const result = await installRuntime({
      arch: "x64",
      lock: lockFor("b.tar.gz", second),
      runtimeDir,
      tmpDir: dir,
    });
    expect(result.action).toBe("installed");
  });

  test("refuses an archive whose SHA-256 does not match, leaving nothing behind", async () => {
    const archive = await makeArchive("a.tar.gz");
    const runtimeDir = join(dir, "runtime");
    const lock = lockFor("a.tar.gz", { ...archive, sha256: "f".repeat(64) });
    const error = await installRuntime({ arch: "x64", lock, runtimeDir, tmpDir: dir }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ChecksumMismatchError);
    expect((error as ChecksumMismatchError).actual).toBe(archive.sha256);
    await expect(lstat(join(runtimeDir, "x64"))).rejects.toThrow();
    expect((await readdir(dir)).filter((n) => n.startsWith("dawg-runtime-"))).toEqual([]);
  });

  test("refuses binaries for the wrong architecture", async () => {
    const archive = await makeArchive("a.tar.gz", { cpuType: CPU_ARM64 });
    await expect(
      installRuntime({
        arch: "x64",
        lock: lockFor("a.tar.gz", archive),
        runtimeDir: join(dir, "rt"),
        tmpDir: dir,
      }),
    ).rejects.toMatchObject({
      code: "install-failed",
      message: expect.stringContaining("not a Mach-O image for x64"),
    });
  });

  test("fails when a needed library or the licence is missing", async () => {
    const noLib = await makeArchive("a.tar.gz", { dropLibrary: true });
    await expect(
      installRuntime({
        arch: "x64",
        lock: lockFor("a.tar.gz", noLib),
        runtimeDir: join(dir, "rt"),
        tmpDir: dir,
      }),
    ).rejects.toThrow(/libggml.1.dylib is needed/);
    const noLicence = await makeArchive("b.tar.gz", { dropLicense: true });
    await expect(
      installRuntime({
        arch: "x64",
        lock: lockFor("b.tar.gz", noLicence),
        runtimeDir: join(dir, "rt"),
        tmpDir: dir,
      }),
    ).rejects.toThrow(/no LICENSE/);
  });
});

describe("ensureTestModel", () => {
  test("downloads once, verifies, then reuses", async () => {
    served.set("/m.gguf", Buffer.from("model"));
    const lock = lockFor("x", { sha256: "0".repeat(64), size: 1 });
    const modelDir = join(dir, "models");
    const path = await ensureTestModel({ pin: lock.testModel, dir: modelDir });
    expect(await readFile(path, "utf8")).toBe("model");
    await ensureTestModel({ pin: lock.testModel, dir: modelDir });
    expect(requests).toEqual(["/m.gguf"]);
  });

  test("rejects a model whose bytes do not match the pin", async () => {
    served.set("/m.gguf", Buffer.from("other"));
    const lock = lockFor("x", { sha256: "0".repeat(64), size: 1 });
    await expect(
      ensureTestModel({ pin: lock.testModel, dir: join(dir, "models") }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(await readdir(join(dir, "models"))).toEqual([]);
  });
});

describe("runtime.lock.json", () => {
  test("is valid and pins both macOS archives from the official repo", async () => {
    const lock = await readRuntimeLock();
    for (const arch of ["arm64", "x64"] as const) {
      const a = lock.llamaCpp.archives[arch];
      expect(a.name).toBe(`llama-${lock.llamaCpp.tag}-bin-macos-${arch}.tar.gz`);
      expect(a.url).toBe(
        `https://github.com/ggml-org/llama.cpp/releases/download/${lock.llamaCpp.tag}/${a.name}`,
      );
    }
    expect(lock.testModel.url).toContain(`/resolve/${lock.testModel.revision}/`);
    expect(lock.testModel.sizeBytes).toBeLessThan(100 * 1024 * 1024);
  });
});
