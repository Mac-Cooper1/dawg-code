import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type CommandRunner, classifyChip, defaultFreeSpace, probeHardware } from "./index.ts";

const GiB = 1024 ** 3;

/** A fake `sysctl` / `sw_vers`: keys missing from the table fail like an unknown oid. */
function fakeMachine(values: Record<string, string>): CommandRunner {
  return async (command, args) => {
    const key = command === "sw_vers" ? "sw_vers" : (args[args.length - 1] ?? "");
    const value = values[key];
    if (value === undefined) throw new Error(`${command}: unknown oid '${key}'`);
    return `${value}\n`;
  };
}

const noDisk = async () => 500 * GiB;

describe("classifyChip", () => {
  test.each([
    ["Apple M4 Max", "max"],
    ["Apple M3 Pro", "pro"],
    ["Apple M2 Ultra", "ultra"],
    ["Apple M4", "base"],
    ["Apple M1", "base"],
    ["Apple M5 Pro", "pro"],
    ["  apple   m3   max  ", "max"],
    ["Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz", "intel"],
    ["Apple M9 Hyper", "base"],
    ["", "base"],
    ["VirtualApple @ 2.50GHz processor", "base"],
    ["Apple M4 Maxi", "base"],
  ])("%j → %s", (chip, expected) => {
    expect(classifyChip(chip)).toBe(expected);
  });
});

describe("probeHardware", () => {
  test("Apple Silicon Max reads performance cores from perflevel0", async () => {
    const profile = await probeHardware({
      run: fakeMachine({
        "hw.memsize": String(128 * GiB),
        "machdep.cpu.brand_string": "Apple M4 Max",
        "hw.optional.arm64": "1",
        "hw.perflevel0.physicalcpu": "12",
        "hw.physicalcpu": "16",
        sw_vers: "15.7",
      }),
      freeSpace: noDisk,
      modelCacheDir: "/nowhere",
    });
    expect(profile).toEqual({
      arch: "arm64",
      chip: "Apple M4 Max",
      chipClass: "max",
      memoryBytes: 128 * GiB,
      performanceCores: 12,
      freeDiskBytes: 500 * GiB,
      macosVersion: "15.7",
    });
  });

  test.each([
    ["Apple M4", "base", 4],
    ["Apple M3 Pro", "pro", 6],
    ["Apple M2 Ultra", "ultra", 16],
  ] as const)("%s → %s", async (chip, chipClass, cores) => {
    const profile = await probeHardware({
      run: fakeMachine({
        "hw.memsize": String(64 * GiB),
        "machdep.cpu.brand_string": chip,
        "hw.optional.arm64": "1",
        "hw.perflevel0.physicalcpu": String(cores),
        "hw.physicalcpu": String(cores + 4),
        sw_vers: "26.1",
      }),
      freeSpace: noDisk,
      modelCacheDir: "/nowhere",
    });
    expect(profile.chipClass).toBe(chipClass);
    expect(profile.performanceCores).toBe(cores);
    expect(profile.arch).toBe("arm64");
  });

  test("Intel falls back to hw.physicalcpu and is classed intel", async () => {
    const profile = await probeHardware({
      run: fakeMachine({
        "hw.memsize": "17179869184",
        "machdep.cpu.brand_string": "Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz",
        "hw.optional.arm64": "0",
        "hw.physicalcpu": "8",
        sw_vers: "15.7",
      }),
      freeSpace: noDisk,
      modelCacheDir: "/nowhere",
    });
    expect(profile.arch).toBe("x64");
    expect(profile.chipClass).toBe("intel");
    expect(profile.performanceCores).toBe(8);
    expect(profile.memoryBytes).toBe(16 * GiB);
  });

  test("older Intel without hw.optional.arm64 is still x64 from the brand string", async () => {
    const profile = await probeHardware({
      run: fakeMachine({
        "hw.memsize": "17179869184",
        "machdep.cpu.brand_string": "Intel(R) Core(TM) i7-8850H CPU @ 2.60GHz",
        "hw.physicalcpu": "6",
        sw_vers: "13.6",
      }),
      freeSpace: noDisk,
      modelCacheDir: "/nowhere",
      processArch: "arm64",
    });
    expect(profile.arch).toBe("x64");
    expect(profile.chipClass).toBe("intel");
  });

  test("an x64 process under Rosetta still reports the Apple chip", async () => {
    const profile = await probeHardware({
      run: fakeMachine({
        "hw.memsize": String(64 * GiB),
        "machdep.cpu.brand_string": "Apple M3 Pro",
        "hw.optional.arm64": "1",
        "hw.perflevel0.physicalcpu": "6",
        sw_vers: "15.0",
      }),
      freeSpace: noDisk,
      modelCacheDir: "/nowhere",
      processArch: "x64",
    });
    expect(profile.arch).toBe("arm64");
    expect(profile.chipClass).toBe("pro");
  });

  test("odd and missing values never throw", async () => {
    const profile = await probeHardware({
      run: fakeMachine({
        "hw.memsize": "not a number",
        "machdep.cpu.brand_string": "   ",
        "hw.optional.arm64": "1",
        "hw.perflevel0.physicalcpu": "-3",
      }),
      freeSpace: async () => {
        throw new Error("no volume");
      },
      modelCacheDir: "/nowhere",
    });
    expect(profile).toEqual({
      arch: "arm64",
      chip: "",
      chipClass: "base",
      memoryBytes: 0,
      performanceCores: 0,
      freeDiskBytes: 0,
      macosVersion: "",
    });
  });

  test("measures free space on the cache directory's volume", async () => {
    const seen: string[] = [];
    await probeHardware({
      run: fakeMachine({}),
      freeSpace: async (path) => {
        seen.push(path);
        return 1;
      },
      modelCacheDir: "/Volumes/Models/hub",
    });
    expect(seen).toEqual(["/Volumes/Models/hub"]);
  });
});

describe("defaultFreeSpace", () => {
  test("walks up to the nearest existing directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dawg-hw-"));
    try {
      const free = await defaultFreeSpace(join(dir, "does", "not", "exist"));
      expect(free).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
