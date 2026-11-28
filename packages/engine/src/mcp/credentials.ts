/**
 * Where MCP sign-ins are kept (Phase 4 spec, MCP: "tokens in the Keychain"): a server's OAuth
 * tokens and dawg's registration with its authorization server, behind one small interface so
 * the engine never cares which store it has.
 *
 * Keyed by the server's scope, name and URL origin: a server whose URL moves to another origin
 * starts signed out, so it is never sent a token another server was given.
 *
 * - Keychain, the default on macOS for the app and the command line, so a sign-in in one holds in
 *   the other. It runs `/usr/bin/security`; secrets go on its standard input (`security -i`),
 *   never on its command line, where other programs could read them. One generic-password item
 *   per server, in a service named after a short hash of the data root, so the dev build, the
 *   release build and temporary data roots never share or overwrite each other's items.
 * - File: `<data root>/mcp-credentials.json`, readable by the person alone (0600), replaced in
 *   one rename. The default elsewhere, and with `DAWG_CREDENTIAL_STORE=file`.
 * - Memory: `DAWG_CREDENTIAL_STORE=memory`; gone when the process ends.
 *
 * Tests never reach the real Keychain: the Keychain store refuses to run `security` while
 * Vitest runs (`VITEST` is set), and without a choice tests get the memory store.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { McpScope } from "@dawg/compat";
import type { StoredOAuthClientInformation, StoredOAuthTokens } from "@modelcontextprotocol/client";
import { atomicWriteFile } from "../tools/files/atomic-write.ts";

export const CREDENTIALS_FILE = "mcp-credentials.json";

/** Which server a sign-in belongs to. */
export interface McpCredentialKey {
  scope: McpScope;
  name: string;
  /** The server URL's origin: "https://mcp.example.com". */
  origin: string;
}

/** What is kept for one server. Both parts are secrets. */
export interface McpCredentials {
  /** The tokens the authorization server issued, as the SDK keeps them. */
  tokens?: StoredOAuthTokens;
  /** dawg's registration with the authorization server, or the client given in advance. */
  client?: StoredOAuthClientInformation;
}

export interface McpCredentialStore {
  readonly kind: "keychain" | "file" | "memory";
  get(key: McpCredentialKey): Promise<McpCredentials | null>;
  set(key: McpCredentialKey, value: McpCredentials): Promise<void>;
  delete(key: McpCredentialKey): Promise<void>;
}

/** One string per key, for maps and files. */
export function credentialId(key: McpCredentialKey): string {
  return JSON.stringify([key.scope, key.name, key.origin]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Only the fields the SDK needs again, so an item stays small (an `id_token` or a registration's
 * metadata can be large) and nothing else is kept.
 */
export function trimCredentials(value: McpCredentials): McpCredentials {
  const out: McpCredentials = {};
  const t = value.tokens;
  if (t !== undefined) {
    out.tokens = {
      access_token: t.access_token,
      token_type: t.token_type,
      ...(t.expires_in === undefined ? {} : { expires_in: t.expires_in }),
      ...(t.scope === undefined ? {} : { scope: t.scope }),
      ...(t.refresh_token === undefined ? {} : { refresh_token: t.refresh_token }),
      ...(t.issuer === undefined ? {} : { issuer: t.issuer }),
    };
  }
  const c = value.client as (StoredOAuthClientInformation & Record<string, unknown>) | undefined;
  if (c !== undefined) {
    const client: Record<string, unknown> = { client_id: c.client_id };
    for (const field of [
      "client_secret",
      "client_id_issued_at",
      "client_secret_expires_at",
      "issuer",
      "redirect_uris",
      "token_endpoint_auth_method",
    ]) {
      if (c[field] !== undefined) client[field] = c[field];
    }
    out.client = client as unknown as StoredOAuthClientInformation;
  }
  return out;
}

/** Reads back what was stored; anything that is not credentials is dropped. */
function parseCredentials(value: unknown): McpCredentials | null {
  if (!isPlainObject(value)) return null;
  const out: McpCredentials = {};
  const tokens = value.tokens;
  if (isPlainObject(tokens) && typeof tokens.access_token === "string") {
    out.tokens = tokens as unknown as StoredOAuthTokens;
  }
  const client = value.client;
  if (isPlainObject(client) && typeof client.client_id === "string") {
    out.client = client as unknown as StoredOAuthClientInformation;
  }
  return out.tokens === undefined && out.client === undefined ? null : out;
}

// --- Memory ----------------------------------------------------------------------------------

export class MemoryCredentialStore implements McpCredentialStore {
  readonly kind = "memory" as const;
  readonly #items = new Map<string, string>();

  async get(key: McpCredentialKey): Promise<McpCredentials | null> {
    const text = this.#items.get(credentialId(key));
    return text === undefined ? null : parseCredentials(JSON.parse(text));
  }

  async set(key: McpCredentialKey, value: McpCredentials): Promise<void> {
    // A copy, so a caller changing its object later does not change what is stored.
    this.#items.set(credentialId(key), JSON.stringify(trimCredentials(value)));
  }

  async delete(key: McpCredentialKey): Promise<void> {
    this.#items.delete(credentialId(key));
  }
}

// --- File ------------------------------------------------------------------------------------

interface CredentialsFile {
  version: 1;
  /** By `credentialId`. */
  servers: Record<string, McpCredentials>;
}

export class FileCredentialStore implements McpCredentialStore {
  readonly kind = "file" as const;
  readonly file: string;
  /** Read-modify-write steps run one after another. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dataRoot: string) {
    this.file = path.join(path.resolve(dataRoot), CREDENTIALS_FILE);
  }

  async #read(): Promise<CredentialsFile> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, servers: {} };
      throw error;
    }
    try {
      const data = JSON.parse(text) as unknown;
      if (isPlainObject(data) && isPlainObject(data.servers)) {
        return { version: 1, servers: data.servers as Record<string, McpCredentials> };
      }
    } catch {
      // A damaged file holds nothing usable; the next write replaces it.
    }
    return { version: 1, servers: {} };
  }

  #step<T>(run: () => Promise<T>): Promise<T> {
    const step = this.#queue.then(run);
    this.#queue = step.catch(() => {});
    return step;
  }

  async #write(data: CredentialsFile): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await atomicWriteFile(this.file, Buffer.from(`${JSON.stringify(data, null, 2)}\n`), {
      mode: 0o600,
    });
  }

  get(key: McpCredentialKey): Promise<McpCredentials | null> {
    return this.#step(async () =>
      parseCredentials((await this.#read()).servers[credentialId(key)]),
    );
  }

  set(key: McpCredentialKey, value: McpCredentials): Promise<void> {
    return this.#step(async () => {
      const data = await this.#read();
      data.servers[credentialId(key)] = trimCredentials(value);
      await this.#write(data);
    });
  }

  delete(key: McpCredentialKey): Promise<void> {
    return this.#step(async () => {
      const data = await this.#read();
      const id = credentialId(key);
      if (!(id in data.servers)) return;
      delete data.servers[id];
      await this.#write(data);
    });
  }
}

// --- Keychain --------------------------------------------------------------------------------

/** Runs `/usr/bin/security` with `args`, writing `stdin` to it when given. */
export type SecurityRunner = (
  args: readonly string[],
  stdin: string | null,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** `security`'s exit status when the item is not there (errSecItemNotFound). */
const ITEM_NOT_FOUND = 44;
/**
 * `security -i` reads its commands in lines of at most 4,095 characters and cuts longer ones, so
 * a large sign-in is spread over a few items; almost every one fits in the first.
 */
const CHUNK_CHARS = 3_600;
const MAX_CHUNKS = 16;
const PREFIX = "dawg1";

/** The real `security`. Refuses to run under Vitest, so no test reaches the person's Keychain. */
export const runSecurity: SecurityRunner = (args, stdin) => {
  if (process.env.VITEST !== undefined) {
    return Promise.reject(
      new Error("The Keychain is never used while tests run; use the memory or file store."),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin ?? undefined);
  });
};

/** Only characters `security -i` never splits or quotes, for names on its command lines. */
function safeWord(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60) || "_";
}

function shortHash(text: string, chars: number): string {
  return createHash("sha256").update(text).digest("hex").slice(0, chars);
}

/** The Keychain service of a data root: "dawg-code.mcp.1a2b3c4d5e". */
export function keychainService(dataRoot: string): string {
  return `dawg-code.mcp.${shortHash(path.resolve(dataRoot), 10)}`;
}

/** The item's account: readable in Keychain Access, unique through the hash of the whole key. */
export function keychainAccount(key: McpCredentialKey): string {
  let host = key.origin;
  try {
    host = new URL(key.origin).host;
  } catch {
    // Not a URL: the hash still keeps it apart.
  }
  return `${key.scope}.${safeWord(key.name)}.${safeWord(host)}.${shortHash(credentialId(key), 12)}`;
}

/** Credentials as text `security` stores and prints back unchanged: deflated, then base64. */
function encode(value: McpCredentials): string {
  return deflateRawSync(Buffer.from(JSON.stringify(trimCredentials(value)))).toString("base64");
}

function decode(text: string): McpCredentials | null {
  try {
    return parseCredentials(JSON.parse(inflateRawSync(Buffer.from(text, "base64")).toString()));
  } catch {
    return null;
  }
}

export class KeychainCredentialStore implements McpCredentialStore {
  readonly kind = "keychain" as const;
  readonly service: string;
  readonly #run: SecurityRunner;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: { dataRoot: string; run?: SecurityRunner }) {
    this.service = keychainService(options.dataRoot);
    this.#run = options.run ?? runSecurity;
  }

  #step<T>(run: () => Promise<T>): Promise<T> {
    const step = this.#queue.then(run);
    this.#queue = step.catch(() => {});
    return step;
  }

  /** One item's password, or null when there is none. */
  async #find(account: string): Promise<string | null> {
    const result = await this.#run(
      ["find-generic-password", "-s", this.service, "-a", account, "-w"],
      null,
    );
    if (result.code === ITEM_NOT_FOUND) return null;
    if (result.code !== 0) throw keychainError("read", result.stderr);
    return result.stdout.replace(/\r?\n$/, "");
  }

  async #remove(account: string): Promise<void> {
    const result = await this.#run(
      ["delete-generic-password", "-s", this.service, "-a", account],
      null,
    );
    if (result.code !== 0 && result.code !== ITEM_NOT_FOUND) {
      throw keychainError("delete", result.stderr);
    }
  }

  /** How many items the server's sign-in takes now (0 when there is none). */
  async #count(account: string): Promise<number> {
    const first = await this.#find(account);
    if (first === null) return 0;
    const match = new RegExp(`^${PREFIX}\\.(\\d+)\\.`).exec(first);
    return match === null ? 1 : Math.min(MAX_CHUNKS, Math.max(1, Number(match[1])));
  }

  get(key: McpCredentialKey): Promise<McpCredentials | null> {
    return this.#step(async () => {
      const account = keychainAccount(key);
      const first = await this.#find(account);
      if (first === null) return null;
      const match = new RegExp(`^${PREFIX}\\.(\\d+)\\.(.*)$`, "s").exec(first);
      if (match === null) return null;
      const count = Math.min(MAX_CHUNKS, Number(match[1]));
      let text = match[2] as string;
      for (let i = 1; i < count; i++) {
        const part = await this.#find(`${account}.${i}`);
        if (part === null) return null;
        text += part;
      }
      return decode(text);
    });
  }

  set(key: McpCredentialKey, value: McpCredentials): Promise<void> {
    return this.#step(async () => {
      const account = keychainAccount(key);
      const text = encode(value);
      const chunks: string[] = [];
      for (let at = 0; at < text.length; at += CHUNK_CHARS) {
        chunks.push(text.slice(at, at + CHUNK_CHARS));
      }
      if (chunks.length === 0) chunks.push("");
      if (chunks.length > MAX_CHUNKS) {
        throw new Error("The sign-in is too large to keep in the Keychain.");
      }
      const before = await this.#count(account);
      // Base64 and the names hold no spaces or quotes, so each command line is read as written.
      const lines = chunks.map((chunk, i) => {
        const data = i === 0 ? `${PREFIX}.${chunks.length}.${chunk}` : chunk;
        const item = i === 0 ? account : `${account}.${i}`;
        return `add-generic-password -U -s ${this.service} -a ${item} -w ${data}`;
      });
      const result = await this.#run(["-i"], `${lines.join("\n")}\n`);
      if (result.code !== 0) throw keychainError("save", result.stderr);
      for (let i = chunks.length; i < before; i++) await this.#remove(`${account}.${i}`);
    });
  }

  delete(key: McpCredentialKey): Promise<void> {
    return this.#step(async () => {
      const account = keychainAccount(key);
      const count = await this.#count(account);
      for (let i = count - 1; i >= 1; i--) await this.#remove(`${account}.${i}`);
      await this.#remove(account);
    });
  }
}

function keychainError(what: "read" | "save" | "delete", stderr: string): Error {
  // `security` names the problem ("User interaction is not allowed."); it never prints secrets.
  const said = stderr
    .split("\n")
    .map((line) => line.replace(/^security:\s*/, "").trim())
    .find((line) => line !== "");
  return new Error(
    `Could not ${what} the sign-in in the Keychain${said === undefined ? "." : `: ${said}`}`,
  );
}

// --- Choosing one ----------------------------------------------------------------------------

/**
 * The store for this process: `DAWG_CREDENTIAL_STORE` (keychain, file or memory) when set; else
 * the Keychain on macOS and the file elsewhere. Under Vitest without a choice, memory.
 */
export function createCredentialStore(options: {
  dataRoot: string;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  run?: SecurityRunner;
}): McpCredentialStore {
  const env = options.env ?? process.env;
  const choice = (env.DAWG_CREDENTIAL_STORE ?? "").trim().toLowerCase();
  const platform = options.platform ?? process.platform;
  const keychain = () =>
    new KeychainCredentialStore({
      dataRoot: options.dataRoot,
      ...(options.run === undefined ? {} : { run: options.run }),
    });
  if (choice === "memory") return new MemoryCredentialStore();
  if (choice === "file") return new FileCredentialStore(options.dataRoot);
  if (choice === "keychain") return keychain();
  if (env.VITEST !== undefined && options.run === undefined) return new MemoryCredentialStore();
  return platform === "darwin" ? keychain() : new FileCredentialStore(options.dataRoot);
}
