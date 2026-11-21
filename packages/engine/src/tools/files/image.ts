/** Recognises the image formats `Read` can hand to a vision model, from their first bytes. */

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageInfo {
  mediaType: ImageMediaType;
  /** Short name for messages, such as "PNG". */
  format: string;
  width: number | null;
  height: number | null;
}

export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

/** Returns what kind of image `bytes` holds, or null if it is not one we recognise. */
export function detectImage(bytes: Uint8Array): ImageInfo | null {
  const b = bytes;
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    const ok = b.length >= 24;
    return {
      mediaType: "image/png",
      format: "PNG",
      width: ok ? u32be(b, 16) : null,
      height: ok ? u32be(b, 20) : null,
    };
  }
  if (
    startsWith(b, [0x47, 0x49, 0x46, 0x38]) &&
    (b[4] === 0x37 || b[4] === 0x39) &&
    b[5] === 0x61
  ) {
    const ok = b.length >= 10;
    return {
      mediaType: "image/gif",
      format: "GIF",
      width: ok ? u16le(b, 6) : null,
      height: ok ? u16le(b, 8) : null,
    };
  }
  if (startsWith(b, [0xff, 0xd8, 0xff])) {
    const size = jpegSize(b);
    return {
      mediaType: "image/jpeg",
      format: "JPEG",
      width: size?.[0] ?? null,
      height: size?.[1] ?? null,
    };
  }
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && ascii(b, 8, 4) === "WEBP") {
    const size = webpSize(b);
    return {
      mediaType: "image/webp",
      format: "WebP",
      width: size?.[0] ?? null,
      height: size?.[1] ?? null,
    };
  }
  return null;
}

function jpegSize(b: Uint8Array): [number, number] | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] ?? 0;
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Start-of-frame markers carry the size; C4, C8 and CC are other segments in that range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [u16be(b, i + 7), u16be(b, i + 5)];
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

function webpSize(b: Uint8Array): [number, number] | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 " && b.length >= 30) {
    return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff];
  }
  if (chunk === "VP8L" && b.length >= 25) {
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (chunk === "VP8X" && b.length >= 30) {
    return [u24le(b, 24) + 1, u24le(b, 27) + 1];
  }
  return null;
}

function startsWith(b: Uint8Array, prefix: number[]): boolean {
  return prefix.every((v, i) => b[i] === v);
}

function ascii(b: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...b.subarray(start, start + length));
}

function u16be(b: Uint8Array, i: number): number {
  return ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
}

function u16le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
}

function u24le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
}

function u32be(b: Uint8Array, i: number): number {
  return (
    (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0
  );
}
