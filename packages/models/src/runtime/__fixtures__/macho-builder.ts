/** Builds minimal Mach-O images (headers and load commands only) for tests. */

export const CPU_X86_64 = 0x01000007;
export const CPU_ARM64 = 0x0100000c;

export interface MachOSpec {
  cpuType: number;
  dylibs?: { name: string; weak?: boolean }[];
  rpaths?: string[];
}

function pad8(n: number): number {
  return (n + 7) & ~7;
}

function lcStringCommand(cmd: number, headerSize: number, text: string, fill: (b: Buffer) => void): Buffer {
  const str = Buffer.from(`${text}\0`, "utf8");
  const size = pad8(headerSize + str.length);
  const buf = Buffer.alloc(size);
  buf.writeUInt32LE(cmd, 0);
  buf.writeUInt32LE(size, 4);
  buf.writeUInt32LE(headerSize, 8);
  fill(buf);
  str.copy(buf, headerSize);
  return buf;
}

export function buildMachO(spec: MachOSpec): Buffer {
  const commands: Buffer[] = [];
  for (const lib of spec.dylibs ?? []) {
    commands.push(
      lcStringCommand(lib.weak ? 0x80000018 : 0xc, 24, lib.name, (b) => {
        b.writeUInt32LE(2, 12); // timestamp
        b.writeUInt32LE(0x10000, 16); // current version
        b.writeUInt32LE(0x10000, 20); // compatibility version
      }),
    );
  }
  for (const rpath of spec.rpaths ?? []) {
    commands.push(lcStringCommand(0x8000001c, 12, rpath, () => {}));
  }
  const body = Buffer.concat(commands);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(spec.cpuType, 4);
  header.writeUInt32LE(0, 8);
  header.writeUInt32LE(2, 12); // MH_EXECUTE
  header.writeUInt32LE(commands.length, 16);
  header.writeUInt32LE(body.length, 20);
  return Buffer.concat([header, body, Buffer.alloc(64)]);
}

/** A universal binary holding the given thin images. */
export function buildFat(images: { cpuType: number; image: Buffer }[]): Buffer {
  const align = 12; // 4 KiB
  const header = Buffer.alloc(8 + images.length * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(images.length, 4);
  const parts: Buffer[] = [header];
  let offset = 1 << align;
  images.forEach(({ cpuType, image }, i) => {
    const at = 8 + i * 20;
    header.writeUInt32BE(cpuType, at);
    header.writeUInt32BE(0, at + 4);
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(image.length, at + 12);
    header.writeUInt32BE(align, at + 16);
    offset += pad(image.length, 1 << align);
  });
  let written = header.length;
  let next = 1 << align;
  for (const { image } of images) {
    parts.push(Buffer.alloc(next - written), image);
    written = next + image.length;
    next += pad(image.length, 1 << align);
  }
  return Buffer.concat(parts);
}

function pad(n: number, to: number): number {
  return Math.ceil(n / to) * to;
}
