/**
 * Keys for remote servers. Each key is encrypted with Electron's `safeStorage`, whose key lives
 * in the macOS Keychain, and the ciphertext is kept in `<data root>/server-keys.json` (mode
 * 0600). A key is decrypted only when a request needs it, and it never goes into `ModelsState`,
 * a log line or any plain file.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "../json-file.ts";
import { messageOf } from "./format.ts";

/** The slice of Electron's `safeStorage` the store uses. */
export interface Encryption {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
}

export interface KeyStore {
  /** Reads the file once. Later calls do nothing. */
  load(): Promise<void>;
  /** Whether a key is stored for the server. Valid after `load`. */
  has(serverId: string): boolean;
  /** The key in the clear, or undefined when none is stored or it cannot be decrypted. */
  get(serverId: string): Promise<string | undefined>;
  set(serverId: string, key: string): Promise<void>;
  delete(serverId: string): Promise<void>;
}

export const KEYS_FILE = "server-keys.json";

const KeysFileSchema = z.record(z.string(), z.string());

export function createKeyStore(dataRoot: string, encryption: Encryption, log: Logger): KeyStore {
  const file = path.join(dataRoot, KEYS_FILE);
  let ciphertexts = new Map<string, string>();
  let loaded: Promise<void> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<void> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`Could not read the stored server keys: ${messageOf(error)}`);
      }
      return;
    }
    try {
      ciphertexts = new Map(Object.entries(KeysFileSchema.parse(JSON.parse(text))));
    } catch {
      log(`Ignoring ${file}: it is not a valid key file.`);
    }
  }

  function write(): Promise<void> {
    const run = queue.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(Object.fromEntries(ciphertexts), null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(temp, 0o600);
      await rename(temp, file);
    });
    queue = run.catch(() => {});
    return run;
  }

  return {
    load() {
      loaded ??= read();
      return loaded;
    },
    has: (serverId) => ciphertexts.has(serverId),
    async get(serverId) {
      const stored = ciphertexts.get(serverId);
      if (stored === undefined) return undefined;
      try {
        return encryption.decryptString(Buffer.from(stored, "base64"));
      } catch (error) {
        log(`Could not decrypt the key for ${serverId}: ${messageOf(error)}`);
        return undefined;
      }
    },
    async set(serverId, key) {
      if (!encryption.isEncryptionAvailable()) {
        throw new Error("Keys cannot be stored safely on this Mac: the Keychain is not available.");
      }
      ciphertexts.set(serverId, encryption.encryptString(key).toString("base64"));
      await write();
    },
    async delete(serverId) {
      if (!ciphertexts.delete(serverId)) return;
      if (ciphertexts.size === 0) {
        await queue;
        await rm(file, { force: true });
        return;
      }
      await write();
    },
  };
}
