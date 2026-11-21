import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveHubCacheDir } from "../download/paths.ts";
import type { ChipClass, HardwareProfile } from "../types.ts";

/** Runs a command and resolves with its stdout. Rejects when the command fails. */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<string>;

/** Free bytes available to this user on the volume holding `path`. */
export type FreeSpaceReader = (path: string) => Promise<number>;

export interface ProbeOptions {
  run?: CommandRunner;
  freeSpace?: FreeSpaceReader;
  /** Directory whose volume is measured for free space. Defaults to the Hugging Face hub cache. */
  modelCacheDir?: string;
  /** Used only when the machine's architecture cannot be read from `sysctl`. */
  processArch?: string;
}

export const defaultCommandRunner: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: 5000, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

/**
 * Free space on the volume holding `path`. The path does not have to exist yet:
 * the nearest existing ancestor is measured instead.
 */
export const defaultFreeSpace: FreeSpaceReader = async (path) => {
  let current = path;
  for (;;) {
    try {
      const stats = await statfs(current);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch (error) {
      const parent = dirname(current);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) throw error;
      current = parent;
    }
  }
};

/**
 * Maps a chip marketing name to a chip class.
 * "Apple M4 Max" → max, "Apple M3 Pro" → pro, "Apple M2 Ultra" → ultra, "Apple M4" → base,
 * anything naming Intel → intel. Any other string (an unknown Apple chip, an empty or odd
 * brand string) → base; the caller decides "intel" from the architecture when it knows better.
 */
export function classifyChip(chip: string): ChipClass {
  const name = chip.trim().toLowerCase();
  if (/\bintel\b/.test(name)) return "intel";
  if (/\bultra\b/.test(name)) return "ultra";
  if (/\bmax\b/.test(name)) return "max";
  if (/\bpro\b/.test(name)) return "pro";
  return "base";
}

async function tryRun(run: CommandRunner, command: string, args: string[]): Promise<string | null> {
  try {
    const out = (await run(command, args)).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function positiveInt(text: string | null): number | null {
  if (text === null || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Reads the machine once: memory, chip and performance cores through `sysctl`, the macOS
 * version through `sw_vers`, and free disk on the model cache volume. Never throws for a
 * missing value: unknown numbers come back as 0, which yields no recommendation.
 */
export async function probeHardware(options: ProbeOptions = {}): Promise<HardwareProfile> {
  const run = options.run ?? defaultCommandRunner;
  const freeSpace = options.freeSpace ?? defaultFreeSpace;
  const cacheDir = options.modelCacheDir ?? resolveHubCacheDir();

  const [memsize, brand, arm64Flag, perfCores, physicalCores, macos] = await Promise.all([
    tryRun(run, "sysctl", ["-n", "hw.memsize"]),
    tryRun(run, "sysctl", ["-n", "machdep.cpu.brand_string"]),
    tryRun(run, "sysctl", ["-n", "hw.optional.arm64"]),
    // Exists only on Apple Silicon (performance cluster).
    tryRun(run, "sysctl", ["-n", "hw.perflevel0.physicalcpu"]),
    tryRun(run, "sysctl", ["-n", "hw.physicalcpu"]),
    tryRun(run, "sw_vers", ["-productVersion"]),
  ]);

  const chip = (brand ?? "").replace(/\s+/g, " ").trim();
  let arch: HardwareProfile["arch"];
  if (arm64Flag === "1") arch = "arm64";
  else if (arm64Flag === "0" || /\bintel\b/i.test(chip)) arch = "x64";
  else arch = (options.processArch ?? process.arch) === "arm64" ? "arm64" : "x64";

  // hw.optional.arm64 stays 1 under Rosetta, so an x64 Node process on Apple Silicon
  // is still classified by its real chip.
  const chipClass: ChipClass = arch === "x64" ? "intel" : classifyChip(chip);

  let freeDiskBytes = 0;
  try {
    freeDiskBytes = await freeSpace(cacheDir);
  } catch {
    freeDiskBytes = 0;
  }

  return {
    arch,
    chip,
    chipClass: chipClass === "intel" && arch === "arm64" ? "base" : chipClass,
    memoryBytes: positiveInt(memsize) ?? 0,
    performanceCores: positiveInt(perfCores) ?? positiveInt(physicalCores) ?? 0,
    freeDiskBytes,
    macosVersion: macos ?? "",
  };
}
