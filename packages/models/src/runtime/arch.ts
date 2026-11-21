import { execFileSync } from "node:child_process";
import { RuntimeError } from "./errors.ts";

export type RuntimeArch = "arm64" | "x64";

export function isRuntimeArch(value: string): value is RuntimeArch {
  return value === "arm64" || value === "x64";
}

let cachedHostArch: RuntimeArch | undefined;

/**
 * The CPU architecture of the machine, not of this process. An x64 Node running under Rosetta
 * on Apple Silicon must still get the arm64 (Metal) build of llama-server.
 */
export function hostArch(): RuntimeArch {
  if (cachedHostArch) return cachedHostArch;
  const arch = process.arch;
  if (arch === "arm64") {
    cachedHostArch = "arm64";
  } else if (arch === "x64") {
    cachedHostArch = process.platform === "darwin" && isTranslated() ? "arm64" : "x64";
  } else {
    throw new RuntimeError("unsupported-arch", `No llama-server build for architecture ${arch}`);
  }
  return cachedHostArch;
}

function isTranslated(): boolean {
  try {
    const out = execFileSync("/usr/sbin/sysctl", ["-in", "sysctl.proc_translated"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return out.trim() === "1";
  } catch {
    return false;
  }
}
