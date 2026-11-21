import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildFat, buildMachO, CPU_ARM64, CPU_X86_64 } from "./__fixtures__/macho-builder.ts";
import { bundledLibraryName, isSystemLibrary, readMachO } from "./macho.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dawg-macho-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(name: string, data: Buffer): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

describe("readMachO", () => {
  test("lists load commands of a thin image", async () => {
    const path = await file(
      "bin",
      buildMachO({
        cpuType: CPU_ARM64,
        dylibs: [
          { name: "/usr/lib/librdma.dylib", weak: true },
          { name: "@rpath/libllama.1.dylib" },
          { name: "/usr/lib/libSystem.B.dylib" },
        ],
        rpaths: ["@loader_path"],
      }),
    );
    const image = await readMachO(path);
    expect(image).toEqual({
      cpuType: CPU_ARM64,
      dylibs: [
        { name: "/usr/lib/librdma.dylib", weak: true },
        { name: "@rpath/libllama.1.dylib", weak: false },
        { name: "/usr/lib/libSystem.B.dylib", weak: false },
      ],
      rpaths: ["@loader_path"],
    });
    expect(await readMachO(path, CPU_X86_64)).toBeNull();
  });

  test("picks the right slice of a universal binary", async () => {
    const path = await file(
      "fat",
      buildFat([
        {
          cpuType: CPU_X86_64,
          image: buildMachO({ cpuType: CPU_X86_64, dylibs: [{ name: "@rpath/x.dylib" }] }),
        },
        {
          cpuType: CPU_ARM64,
          image: buildMachO({ cpuType: CPU_ARM64, dylibs: [{ name: "@rpath/a.dylib" }] }),
        },
      ]),
    );
    expect((await readMachO(path, CPU_ARM64))?.dylibs).toEqual([
      { name: "@rpath/a.dylib", weak: false },
    ]);
    expect((await readMachO(path, CPU_X86_64))?.dylibs).toEqual([
      { name: "@rpath/x.dylib", weak: false },
    ]);
  });

  test("returns null for anything that is not Mach-O", async () => {
    expect(await readMachO(await file("txt", Buffer.from("MIT License\n")))).toBeNull();
    expect(await readMachO(await file("empty", Buffer.alloc(0)))).toBeNull();
  });
});

describe("library names", () => {
  test("system libraries are never bundled", () => {
    expect(isSystemLibrary("/usr/lib/libc++.1.dylib")).toBe(true);
    expect(isSystemLibrary("/System/Library/Frameworks/Metal.framework/Versions/A/Metal")).toBe(
      true,
    );
    expect(isSystemLibrary("@rpath/libggml.1.dylib")).toBe(false);
  });

  test("relative install names resolve to a file next to the binary", () => {
    expect(bundledLibraryName("@rpath/libggml-metal.1.dylib")).toBe("libggml-metal.1.dylib");
    expect(bundledLibraryName("@loader_path/libx.dylib")).toBe("libx.dylib");
    expect(bundledLibraryName("@executable_path/./liby.dylib")).toBe("liby.dylib");
    expect(bundledLibraryName("@rpath/sub/dir/libz.dylib")).toBeNull();
    expect(bundledLibraryName("/opt/homebrew/lib/libomp.dylib")).toBeNull();
  });
});
