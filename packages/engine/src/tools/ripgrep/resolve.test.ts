import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRipgrepCache,
  RipgrepNotFoundError,
  resolveRipgrep,
  type VerifyOutcome,
  verifyByRunning,
} from "./resolve.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dawg-rg-resolve-"));
  clearRipgrepCache();
});
afterEach(async () => {
  clearRipgrepCache();
  await rm(dir, { recursive: true, force: true });
});

/** Writes an executable script that behaves like `rg --version` (or not). */
async function fakeRg(name: string, versionLine = "ripgrep 99.0.0"): Promise<string> {
  const file = path.join(dir, name, "rg");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/sh\necho '${versionLine}'\n`);
  await chmod(file, 0o755);
  return file;
}

/** A verifier that accepts everything except the listed paths, and counts its calls. */
function fakeVerify(broken: string[] = []) {
  const calls: string[] = [];
  const verify = async (file: string): Promise<VerifyOutcome> => {
    calls.push(file);
    return broken.includes(file) ? { ok: false, problem: "broken" } : { ok: true, version: file };
  };
  return { calls, verify };
}

describe("resolveRipgrep", () => {
  it("prefers the session's path, then DAWG_RG_PATH, then the fetched copy, then PATH", async () => {
    const explicit = await fakeRg("explicit");
    const fromEnv = await fakeRg("env");
    const fetched = await fakeRg("fetched");
    const onPath = await fakeRg("path");
    const env = { DAWG_RG_PATH: fromEnv, PATH: path.dirname(onPath) };

    const { verify } = fakeVerify();
    const all = { env, fetchedPath: fetched, verify };
    expect(await resolveRipgrep({ ...all, explicitPath: explicit })).toMatchObject({
      path: explicit,
      source: "context",
    });
    expect(await resolveRipgrep(all)).toMatchObject({ path: fromEnv, source: "env" });
    expect(await resolveRipgrep({ ...all, env: { PATH: env.PATH } })).toMatchObject({
      path: fetched,
      source: "fetched",
    });
    expect(
      await resolveRipgrep({
        ...all,
        env: { PATH: env.PATH },
        fetchedPath: path.join(dir, "none"),
      }),
    ).toMatchObject({ path: onPath, source: "path" });
  });

  it("moves on from a candidate that fails its check", async () => {
    const explicit = await fakeRg("explicit");
    const fetched = await fakeRg("fetched");
    const { verify, calls } = fakeVerify([explicit]);
    const found = await resolveRipgrep({
      explicitPath: explicit,
      env: { DAWG_RG_PATH: path.join(dir, "missing", "rg"), PATH: "" },
      fetchedPath: fetched,
      verify,
    });
    expect(found).toMatchObject({ path: fetched, source: "fetched" });
    // The missing file is skipped without being run.
    expect(calls).toEqual([explicit, fetched]);
  });

  it("says how to fetch ripgrep when nothing works", async () => {
    const { verify } = fakeVerify();
    const error = await resolveRipgrep({
      env: { PATH: path.join(dir, "empty") },
      fetchedPath: path.join(dir, "missing", "rg"),
      verify,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RipgrepNotFoundError);
    expect((error as Error).message).toContain("pnpm fetch-ripgrep");
    expect((error as RipgrepNotFoundError).attempts.map((a) => a.source)).toEqual([
      "fetched",
      "path",
    ]);
  });

  it("caches a successful check", async () => {
    const fetched = await fakeRg("fetched");
    const { verify, calls } = fakeVerify();
    const options = { env: { PATH: "" }, fetchedPath: fetched, verify };
    await resolveRipgrep(options);
    await resolveRipgrep(options);
    expect(calls).toEqual([fetched]);
    clearRipgrepCache();
    await resolveRipgrep(options);
    expect(calls).toEqual([fetched, fetched]);
  });

  it("does not cache a failed check", async () => {
    const fetched = path.join(dir, "later", "rg");
    const { verify } = fakeVerify();
    const options = { env: { PATH: "" }, fetchedPath: fetched, verify };
    await expect(resolveRipgrep(options)).rejects.toBeInstanceOf(RipgrepNotFoundError);
    await fakeRg("later");
    await expect(resolveRipgrep(options)).resolves.toMatchObject({ path: fetched });
  });

  it("rejects a relative path", async () => {
    const { verify } = fakeVerify();
    const error = (await resolveRipgrep({
      env: { DAWG_RG_PATH: "bin/rg", PATH: "" },
      fetchedPath: path.join(dir, "missing", "rg"),
      verify,
    }).catch((e: unknown) => e)) as RipgrepNotFoundError;
    expect(error).toBeInstanceOf(RipgrepNotFoundError);
    expect(error.attempts[0]).toMatchObject({ source: "env", problem: "not an absolute path" });
  });
});

describe("verifyByRunning", () => {
  it("accepts a binary that identifies itself as ripgrep", async () => {
    const file = await fakeRg("good", "ripgrep 15.2.0 (rev abc)");
    expect(await verifyByRunning(file)).toEqual({ ok: true, version: "ripgrep 15.2.0 (rev abc)" });
  });

  it("rejects a binary that is something else", async () => {
    const file = await fakeRg("other", "grep (GNU grep) 3.11");
    expect(await verifyByRunning(file)).toMatchObject({ ok: false });
  });

  it("rejects a binary that fails", async () => {
    const file = path.join(dir, "fails", "rg");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "#!/bin/sh\nexit 3\n");
    await chmod(file, 0o755);
    expect(await verifyByRunning(file)).toMatchObject({ ok: false });
  });

  it("verifies the fetched ripgrep in this checkout through the default resolver", async () => {
    const found = await resolveRipgrep({ env: { PATH: "" } });
    expect(found.source).toBe("fetched");
    expect(found.version).toMatch(/^ripgrep \d+\.\d+\.\d+/);
  });
});
