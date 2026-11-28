/**
 * Where sign-ins are kept (credentials.ts): each store keeps, replaces and forgets a server's
 * credentials by scope, name and origin. The Keychain store runs against a fake `security`
 * that keeps items in a map, and the test checks no secret ever reaches its command line. No
 * test here, or anywhere, runs the real `security`.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCredentialStore,
  FileCredentialStore,
  KeychainCredentialStore,
  keychainAccount,
  keychainService,
  type McpCredentialKey,
  type McpCredentialStore,
  type McpCredentials,
  MemoryCredentialStore,
  runSecurity,
  type SecurityRunner,
} from "./credentials.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dawg-credentials-"));
  dirs.push(dir);
  return dir;
}

const LINEAR: McpCredentialKey = {
  scope: "user",
  name: "linear",
  origin: "https://mcp.linear.app",
};
const SECRET = "at_super-secret-access-token";
const REFRESH = "rt_super-secret-refresh-token";

function credentials(access = SECRET): McpCredentials {
  return {
    tokens: {
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: REFRESH,
      issuer: "https://auth.linear.app",
      // Not kept: the SDK never needs it again.
      id_token: "id.token.value",
    },
    client: {
      client_id: "client-1",
      redirect_uris: ["http://localhost:4567/callback"],
      issuer: "https://auth.linear.app",
    } as McpCredentials["client"] & object,
  };
}

/** What every store must do. */
async function behaves(store: McpCredentialStore): Promise<void> {
  expect(await store.get(LINEAR)).toBeNull();
  await store.set(LINEAR, credentials());
  const read = await store.get(LINEAR);
  expect(read?.tokens).toEqual({
    access_token: SECRET,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: REFRESH,
    issuer: "https://auth.linear.app",
  });
  expect(read?.client).toMatchObject({ client_id: "client-1" });
  // Another scope, name or origin is another server.
  expect(await store.get({ ...LINEAR, scope: "project" })).toBeNull();
  expect(await store.get({ ...LINEAR, name: "linear2" })).toBeNull();
  expect(await store.get({ ...LINEAR, origin: "https://elsewhere.example" })).toBeNull();
  await store.set(LINEAR, credentials("at_newer"));
  expect((await store.get(LINEAR))?.tokens?.access_token).toBe("at_newer");
  await store.delete(LINEAR);
  expect(await store.get(LINEAR)).toBeNull();
  await store.delete(LINEAR); // Forgetting nothing is fine.
}

describe("the memory store", () => {
  it("keeps, replaces and forgets a server's credentials", async () => {
    await behaves(new MemoryCredentialStore());
  });
});

describe("the file store", () => {
  it("keeps them in <data root>/mcp-credentials.json, readable by the person alone", async () => {
    const root = await tempDir();
    const store = new FileCredentialStore(root);
    await behaves(store);
    await store.set(LINEAR, credentials());
    const file = path.join(root, "mcp-credentials.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const text = await readFile(file, "utf8");
    expect(text).toContain(SECRET);
    expect(text).not.toContain("id.token.value");
    // Written in one rename: no temporary file is left beside it.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(root)).toEqual(["mcp-credentials.json"]);
    // A second store on the same root (the command line beside the app) reads the same.
    expect((await new FileCredentialStore(root).get(LINEAR))?.tokens?.access_token).toBe(SECRET);
  });

  it("treats a damaged file as empty, and replaces it on the next save", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "mcp-credentials.json"), "{ not json");
    const store = new FileCredentialStore(root);
    expect(await store.get(LINEAR)).toBeNull();
    await store.set(LINEAR, credentials());
    expect((await store.get(LINEAR))?.tokens?.access_token).toBe(SECRET);
  });
});

/** A fake `security`: generic passwords in a map, every call recorded. */
function fakeSecurity() {
  const items = new Map<string, string>();
  const calls: { args: string[]; stdin: string | null }[] = [];
  const option = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1] ?? "";
  const run: SecurityRunner = async (args, stdin) => {
    calls.push({ args: [...args], stdin });
    const [command] = args;
    if (command === "find-generic-password") {
      const value = items.get(`${option(args, "-s")}/${option(args, "-a")}`);
      return value === undefined
        ? {
            code: 44,
            stdout: "",
            stderr:
              "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n",
          }
        : { code: 0, stdout: `${value}\n`, stderr: "" };
    }
    if (command === "delete-generic-password") {
      const key = `${option(args, "-s")}/${option(args, "-a")}`;
      return items.delete(key)
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 44, stdout: "", stderr: "" };
    }
    if (command === "-i") {
      for (const line of (stdin ?? "").split("\n").filter(Boolean)) {
        // `security -i` cuts lines at 4,095 characters.
        expect(line.length).toBeLessThan(4095);
        const words = line.split(" ");
        expect(words[0]).toBe("add-generic-password");
        expect(words).toContain("-U");
        items.set(`${option(words, "-s")}/${option(words, "-a")}`, option(words, "-w"));
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `security: unknown command ${command}\n` };
  };
  return { run, items, calls };
}

describe("the Keychain store", () => {
  it("keeps one generic-password item per server, with secrets only on standard input", async () => {
    const fake = fakeSecurity();
    const store = new KeychainCredentialStore({ dataRoot: "/Users/me/.dawg", run: fake.run });
    await behaves(store);
    await store.set(LINEAR, credentials());
    const service = keychainService("/Users/me/.dawg");
    expect([...fake.items.keys()]).toEqual([`${service}/${keychainAccount(LINEAR)}`]);
    expect(keychainAccount(LINEAR)).toMatch(/^user\.linear\.mcp\.linear\.app\.[0-9a-f]{12}$/);
    // The secrets never reach a command line, where other programs could read them.
    for (const call of fake.calls) {
      const argv = call.args.join(" ");
      expect(argv).not.toContain(SECRET);
      expect(argv).not.toContain(REFRESH);
      expect(argv).not.toMatch(/ -w \S/);
      if (call.args[0] === "-i") expect(call.stdin).toMatch(/^add-generic-password /);
    }
    // Nor are they readable in the item as plain text.
    expect([...fake.items.values()].join("")).not.toContain(SECRET);
  });

  it("names its service after the data root, so builds and test roots never share items", () => {
    const release = keychainService("/Users/me/.dawg");
    expect(release).toMatch(/^dawg-code\.mcp\.[0-9a-f]{10}$/);
    expect(keychainService("/Users/me/.dawg/")).toBe(release);
    expect(keychainService("/Users/me/.dawg-dev")).not.toBe(release);
    expect(keychainService("/tmp/dawg-test-1")).not.toBe(release);
  });

  it("spreads a sign-in too large for one command line over a few items", async () => {
    const fake = fakeSecurity();
    const store = new KeychainCredentialStore({ dataRoot: "/Users/me/.dawg", run: fake.run });
    // Random text does not deflate: about 9,000 characters of base64.
    const { randomBytes } = await import("node:crypto");
    const big = randomBytes(6_000).toString("base64");
    await store.set(LINEAR, credentials(big));
    expect(fake.items.size).toBeGreaterThan(1);
    expect((await store.get(LINEAR))?.tokens?.access_token).toBe(big);
    // A smaller one afterwards leaves no stray items, and forgetting removes them all.
    await store.set(LINEAR, credentials());
    expect(fake.items.size).toBe(1);
    await store.set(LINEAR, credentials(big));
    await store.delete(LINEAR);
    expect(fake.items.size).toBe(0);
  });

  it("says what went wrong in plain words, without the command line", async () => {
    const store = new KeychainCredentialStore({
      dataRoot: "/Users/me/.dawg",
      run: async () => ({
        code: 51,
        stdout: "",
        stderr: "security: User interaction is not allowed.\n",
      }),
    });
    await expect(store.get(LINEAR)).rejects.toThrow(
      "Could not read the sign-in in the Keychain: User interaction is not allowed.",
    );
    await expect(store.set(LINEAR, credentials())).rejects.toThrow(/^Could not read/);
  });

  it("refuses to run the real security while tests run", async () => {
    expect(process.env.VITEST).toBeDefined();
    await expect(
      runSecurity(["find-generic-password", "-s", "x", "-a", "y", "-w"], null),
    ).rejects.toThrow("The Keychain is never used while tests run");
    const store = new KeychainCredentialStore({ dataRoot: "/Users/me/.dawg" });
    await expect(store.get(LINEAR)).rejects.toThrow("never used while tests run");
  });
});

describe("choosing a store", () => {
  it("follows DAWG_CREDENTIAL_STORE, else the Keychain on macOS and the file elsewhere", () => {
    const dataRoot = "/Users/me/.dawg";
    const fake = fakeSecurity().run;
    expect(createCredentialStore({ dataRoot, env: { DAWG_CREDENTIAL_STORE: "file" } }).kind).toBe(
      "file",
    );
    expect(createCredentialStore({ dataRoot, env: { DAWG_CREDENTIAL_STORE: "memory" } }).kind).toBe(
      "memory",
    );
    expect(createCredentialStore({ dataRoot, env: {}, platform: "darwin", run: fake }).kind).toBe(
      "keychain",
    );
    expect(createCredentialStore({ dataRoot, env: {}, platform: "linux" }).kind).toBe("file");
    // Under Vitest, without a choice: memory, never the Keychain.
    expect(
      createCredentialStore({ dataRoot, env: { VITEST: "true" }, platform: "darwin" }).kind,
    ).toBe("memory");
  });
});
