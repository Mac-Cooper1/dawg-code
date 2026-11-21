import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { hostArch, type RuntimeArch } from "./arch.ts";
import { RuntimeError } from "./errors.ts";
import { BINARY_NAME, defaultRuntimeDir } from "./install.ts";

export interface ResolveRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  arch?: RuntimeArch;
  /**
   * Parent of the per-arch runtime directories. In a checkout this is
   * `apps/desktop/resources/runtime`; the packaged app passes `<resourcesPath>/runtime`.
   */
  runtimeDir?: string;
}

export interface ResolvedRuntime {
  binary: string;
  source: "env" | "bundled";
  arch: RuntimeArch;
}

/** `DAWG_RUNTIME_BIN` first, then the bundled build for this machine's architecture. */
export async function resolveRuntimeBinary(
  options: ResolveRuntimeOptions = {},
): Promise<ResolvedRuntime> {
  const env = options.env ?? process.env;
  const arch = options.arch ?? hostArch();
  const override = env.DAWG_RUNTIME_BIN;
  if (override) {
    if (!isAbsolute(override)) {
      throw new RuntimeError(
        "not-found",
        `DAWG_RUNTIME_BIN must be an absolute path, got ${override}`,
      );
    }
    await assertExecutable(override, "DAWG_RUNTIME_BIN");
    return { binary: override, source: "env", arch };
  }
  const binary = join(options.runtimeDir ?? defaultRuntimeDir, arch, BINARY_NAME);
  await assertExecutable(
    binary,
    `the bundled ${arch} runtime (run: node scripts/fetch-runtime.ts)`,
  );
  return { binary, source: "bundled", arch };
}

async function assertExecutable(path: string, what: string): Promise<void> {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new RuntimeError("not-found", `No executable llama-server at ${path} for ${what}`);
  }
}
