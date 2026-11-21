import { open } from "node:fs/promises";

/**
 * Just enough Mach-O parsing to list the libraries a binary loads, so the fetch script can copy
 * exactly the dylibs `llama-server` needs (and nothing that `otool` would have to be installed
 * for). Handles thin 64-bit images and universal ("fat") files.
 */

const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;

// Written out in full: `0x18 | 0x80000000` would be a negative int32 in JavaScript.
const LC_LOAD_DYLIB = 0xc;
const LC_LOAD_WEAK_DYLIB = 0x80000018;
const LC_REEXPORT_DYLIB = 0x8000001f;
const LC_LAZY_LOAD_DYLIB = 0x20;
const LC_LOAD_UPWARD_DYLIB = 0x80000023;
const LC_RPATH = 0x8000001c;

const DYLIB_COMMANDS = new Set([
  LC_LOAD_DYLIB,
  LC_LOAD_WEAK_DYLIB,
  LC_REEXPORT_DYLIB,
  LC_LAZY_LOAD_DYLIB,
  LC_LOAD_UPWARD_DYLIB,
]);

export const CPU_TYPE_X86_64 = 0x01000007;
export const CPU_TYPE_ARM64 = 0x0100000c;

export interface MachOImage {
  cpuType: number;
  /** Install names of every library this image loads, in load-command order. */
  dylibs: { name: string; weak: boolean }[];
  rpaths: string[];
}

export function cpuTypeForArch(arch: "arm64" | "x64"): number {
  return arch === "arm64" ? CPU_TYPE_ARM64 : CPU_TYPE_X86_64;
}

/** Returns the image for `cpuType` (or the only image), or null when the file is not Mach-O. */
export async function readMachO(path: string, cpuType?: number): Promise<MachOImage | null> {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(32);
    const { bytesRead } = await handle.read(head, 0, 32, 0);
    if (bytesRead < 8) return null;
    const magicBE = head.readUInt32BE(0);
    if (magicBE === FAT_MAGIC || magicBE === FAT_MAGIC_64) {
      const is64 = magicBE === FAT_MAGIC_64;
      const count = head.readUInt32BE(4);
      const entrySize = is64 ? 32 : 20;
      const table = Buffer.alloc(count * entrySize);
      await handle.read(table, 0, table.length, 8);
      const slices: { cpuType: number; offset: number }[] = [];
      for (let i = 0; i < count; i++) {
        const base = i * entrySize;
        const sliceCpu = table.readUInt32BE(base);
        const offset = is64
          ? Number(table.readBigUInt64BE(base + 8))
          : table.readUInt32BE(base + 8);
        slices.push({ cpuType: sliceCpu, offset });
      }
      const slice = cpuType === undefined ? slices[0] : slices.find((s) => s.cpuType === cpuType);
      if (!slice) return null;
      return await readThin(handle, slice.offset);
    }
    const image = await readThin(handle, 0);
    if (image && cpuType !== undefined && image.cpuType !== cpuType) return null;
    return image;
  } finally {
    await handle.close();
  }
}

async function readThin(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
): Promise<MachOImage | null> {
  const header = Buffer.alloc(32);
  const { bytesRead } = await handle.read(header, 0, 32, offset);
  if (bytesRead < 32) return null;
  const magic = header.readUInt32LE(0);
  if (magic !== MH_MAGIC_64 && magic !== MH_CIGAM_64) return null;
  const le = magic === MH_MAGIC_64;
  const u32 = (buf: Buffer, at: number) => (le ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
  const cpuType = u32(header, 4);
  const ncmds = u32(header, 16);
  const sizeofcmds = u32(header, 20);
  const cmds = Buffer.alloc(sizeofcmds);
  await handle.read(cmds, 0, sizeofcmds, offset + 32);

  const image: MachOImage = { cpuType, dylibs: [], rpaths: [] };
  let at = 0;
  for (let i = 0; i < ncmds && at + 8 <= cmds.length; i++) {
    const cmd = u32(cmds, at);
    const cmdsize = u32(cmds, at + 4);
    if (cmdsize < 8 || at + cmdsize > cmds.length) break;
    if (DYLIB_COMMANDS.has(cmd)) {
      const nameOffset = u32(cmds, at + 8);
      image.dylibs.push({
        name: readCString(cmds, at + nameOffset, at + cmdsize),
        weak: cmd === LC_LOAD_WEAK_DYLIB,
      });
    } else if (cmd === LC_RPATH) {
      const pathOffset = u32(cmds, at + 8);
      image.rpaths.push(readCString(cmds, at + pathOffset, at + cmdsize));
    }
    at += cmdsize;
  }
  return image;
}

function readCString(buf: Buffer, start: number, end: number): string {
  let stop = start;
  while (stop < end && buf[stop] !== 0) stop++;
  return buf.toString("utf8", start, stop);
}

/** True for install names that the OS provides (never bundled). */
export function isSystemLibrary(name: string): boolean {
  return name.startsWith("/usr/lib/") || name.startsWith("/System/");
}

/**
 * For a library that is not a system library, the file name it must have next to the binary.
 * Bundled builds use `@rpath/`, `@loader_path/` or `@executable_path/` with an rpath of
 * `@loader_path`, so the base name is what matters.
 */
export function bundledLibraryName(name: string): string | null {
  const match = /^@(?:rpath|loader_path|executable_path)\/(?:\.\/)?([^/]+)$/.exec(name);
  return match?.[1] ?? null;
}
