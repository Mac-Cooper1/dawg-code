import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installRipgrep, RIPGREP_MANIFEST } from "./install.ts";
import {
  currentTarget,
  isRipgrepTarget,
  type RipgrepLock,
  type RipgrepTarget,
  readRipgrepLock,
} from "./lock.ts";

const execFileAsync = promisify(execFile);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dawg-rg-install-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const here = currentTarget();
const target: RipgrepTarget = isRipgrepTarget(here) ? here : "linux-x64";

/** Builds a release-like archive holding a fake rg and the licence files. */
async function fakeRelease(): Promise<{ bytes: Buffer; lock: RipgrepLock }> {
  const top = path.join(dir, "src", "ripgrep-0.0.1-fake");
  await mkdir(path.join(top, "doc"), { recursive: true });
  await writeFile(path.join(top, "rg"), "#!/bin/sh\necho 'ripgrep 0.0.1'\n");
  await chmod(path.join(top, "rg"), 0o755);
  for (const name of ["COPYING", "LICENSE-MIT", "UNLICENSE"]) {
    await writeFile(path.join(top, name), `${name} text\n`);
  }
  await writeFile(path.join(top, "doc", "rg.1"), "manual\n");
  const archive = path.join(dir, "fake.tar.gz");
  await execFileAsync("tar", ["-czf", archive, "-C", path.join(dir, "src"), "ripgrep-0.0.1-fake"]);
  const bytes = await readFile(archive);
  const entry = {
    name: "ripgrep-0.0.1-fake.tar.gz",
    url: "https://example.test/ripgrep-0.0.1-fake.tar.gz",
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const real = await readRipgrepLock();
  const lock: RipgrepLock = {
    ripgrep: {
      ...real.ripgrep,
      version: "0.0.1",
      archives: { "darwin-arm64": entry, "darwin-x64": entry, "linux-x64": entry },
    },
  };
  return { bytes, lock };
}

function fakeFetch(bytes: Buffer) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    });
  }) as typeof fetch;
  return { urls, fetchImpl };
}

describe("installRipgrep", () => {
  it("installs rg and its licences, then does nothing while they still verify", async () => {
    const { bytes, lock } = await fakeRelease();
    const { urls, fetchImpl } = fakeFetch(bytes);
    const binRoot = path.join(dir, "bin");

    const first = await installRipgrep({ target, lock, binRoot, fetchImpl, tmpDir: dir });
    expect(first.action).toBe("installed");
    expect(first.binary).toBe(path.join(binRoot, target, "rg"));
    expect((await stat(first.binary)).mode & 0o111).not.toBe(0);
    for (const name of ["COPYING", "LICENSE-MIT", "UNLICENSE", RIPGREP_MANIFEST]) {
      await expect(stat(path.join(first.dir, name))).resolves.toBeTruthy();
    }
    await expect(stat(path.join(first.dir, "doc"))).rejects.toThrow();
    if (target === currentTarget()) expect(first.version).toBe("ripgrep 0.0.1");

    const second = await installRipgrep({ target, lock, binRoot, fetchImpl, tmpDir: dir });
    expect(second.action).toBe("already-present");
    expect(urls).toHaveLength(1);
  });

  it("reinstalls when an installed file was changed", async () => {
    const { bytes, lock } = await fakeRelease();
    const { urls, fetchImpl } = fakeFetch(bytes);
    const binRoot = path.join(dir, "bin");
    const first = await installRipgrep({ target, lock, binRoot, fetchImpl, tmpDir: dir });
    await writeFile(first.binary, "#!/bin/sh\necho tampered\n");
    const again = await installRipgrep({ target, lock, binRoot, fetchImpl, tmpDir: dir });
    expect(again.action).toBe("installed");
    expect(urls).toHaveLength(2);
    expect(await readFile(first.binary, "utf8")).toContain("ripgrep 0.0.1");
  });

  it("refuses an archive whose hash does not match and installs nothing", async () => {
    const { bytes, lock } = await fakeRelease();
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    const { fetchImpl } = fakeFetch(tampered);
    const binRoot = path.join(dir, "bin");
    await expect(installRipgrep({ target, lock, binRoot, fetchImpl, tmpDir: dir })).rejects.toThrow(
      /checksum|SHA-256|sha256/i,
    );
    await expect(stat(path.join(binRoot, target, "rg"))).rejects.toThrow();
  });
});

describe("ripgrep.lock.json", () => {
  it("pins an archive for every supported target", async () => {
    const lock = await readRipgrepLock();
    expect(Object.keys(lock.ripgrep.archives).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-x64",
    ]);
    for (const archive of Object.values(lock.ripgrep.archives)) {
      expect(archive.url).toContain(`/releases/download/${lock.ripgrep.tag}/`);
      expect(archive.name).toContain(lock.ripgrep.version);
    }
  });
});
