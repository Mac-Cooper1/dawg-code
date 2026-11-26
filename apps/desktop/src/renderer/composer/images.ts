/**
 * Images for the composer: checking what was pasted, dropped or picked, downscaling it and
 * encoding it for the prompt.
 *
 * - PNG, JPEG, GIF and WebP up to 20 MB; ten images a message.
 * - The longest side is brought down to 2048 px (more only costs context and time).
 * - WebP is always re-encoded: llama.cpp's image loader does not read it.
 * - A large PNG without transparency (a photo or screenshot saved as PNG) becomes a JPEG when
 *   that is at most half the size.
 * - Small JPEG, PNG and GIF files that need no resizing are sent untouched (a GIF keeps its
 *   animation, though models read its first frame).
 *
 * Decoding uses `createImageBitmap`, drawing an `OffscreenCanvas` (a `<canvas>` where there is
 * none); nothing leaves the renderer.
 */
import type { ImageAttachment } from "../state/types.ts";

export const IMAGE_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];
/** For the file picker's `accept`. */
export const IMAGE_ACCEPT = IMAGE_TYPES.join(",");
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGES = 10;
export const MAX_IMAGE_SIDE = 2048;

/** A PNG over this size is worth trying as JPEG. */
const BIG_PNG_BYTES = 1024 * 1024;
/** JPEG and GIF files up to this size that need no resizing are sent as they are. */
const KEEP_BYTES = 5 * 1024 * 1024;
const PHOTO_QUALITY = 0.85;
const JPEG_QUALITY = 0.9;

/** Why an image was not attached, as the one-line notice to show. */
export class ImageRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRefused";
  }
}

export function isImageType(type: string): boolean {
  return IMAGE_TYPES.includes(type);
}

/** The base64 of a blob, without the data-URL prefix. */
export function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("The image could not be read."));
    reader.readAsDataURL(blob);
  });
}

interface Canvas {
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  encode(type: string, quality?: number): Promise<Blob>;
}

function canvasOf(width: number, height: number): Canvas {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D canvas.");
    return {
      context,
      encode: (type, quality) =>
        canvas.convertToBlob(quality === undefined ? { type } : { type, quality }),
    };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D canvas.");
  return {
    context,
    encode: (type, quality) =>
      new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("The image could not be encoded."))),
          type,
          quality,
        );
      }),
  };
}

/** True when no pixel is see-through, so JPEG (which has no transparency) loses nothing. */
function isOpaque(canvas: Canvas, width: number, height: number): boolean {
  const { data } = canvas.context.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
  return true;
}

/** The size that fits within `MAX_IMAGE_SIDE`, keeping the proportions. */
export function fittedSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Checks, decodes, downscales and encodes one image. Rejects with `ImageRefused`. */
export async function prepareImage(file: File, id: string): Promise<ImageAttachment> {
  const name = file.name.trim() === "" ? "Pasted image" : file.name;
  if (!isImageType(file.type)) {
    throw new ImageRefused(`${name} was not attached: only PNG, JPEG, GIF and WebP images can be.`);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ImageRefused(`${name} was not attached: it is over 20 MB.`);
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageRefused(`${name} was not attached: it could not be read as an image.`);
  }
  try {
    const original = { width: bitmap.width, height: bitmap.height };
    const size = fittedSize(original.width, original.height);
    const resized = size.width !== original.width || size.height !== original.height;
    const keep =
      !resized &&
      ((file.type === "image/png" && file.size <= BIG_PNG_BYTES) ||
        ((file.type === "image/jpeg" || file.type === "image/gif") && file.size <= KEEP_BYTES));
    if (keep) {
      return { id, name, mediaType: file.type, data: await base64Of(file), ...original };
    }

    const canvas = canvasOf(size.width, size.height);
    canvas.context.drawImage(bitmap, 0, 0, size.width, size.height);
    let mediaType = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
    let blob = await canvas.encode(
      mediaType,
      mediaType === "image/jpeg" ? JPEG_QUALITY : undefined,
    );
    if (
      mediaType === "image/png" &&
      blob.size > BIG_PNG_BYTES &&
      isOpaque(canvas, size.width, size.height)
    ) {
      const jpeg = await canvas.encode("image/jpeg", PHOTO_QUALITY);
      if (jpeg.size <= blob.size / 2) {
        blob = jpeg;
        mediaType = "image/jpeg";
      }
    }
    return { id, name, mediaType, data: await base64Of(blob), ...size };
  } catch (error) {
    if (error instanceof ImageRefused) throw error;
    throw new ImageRefused(`${name} was not attached: it could not be prepared.`);
  } finally {
    bitmap.close();
  }
}

/** The files a paste or drop carries that are meant as attachments, if any. */
export function filesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files ?? []);
}

/**
 * Whether a paste is images to attach rather than text: it carries files, and is not an office
 * app's rich copy (text and HTML with a picture of them), which should paste as text.
 */
export function pasteIsFiles(data: DataTransfer): boolean {
  if (filesOf(data).length === 0) return false;
  const types = Array.from(data.types ?? []);
  const text = types.includes("text/plain") ? data.getData("text/plain") : "";
  return !(text.trim() !== "" && types.includes("text/html"));
}

/** A drag that carries files (from Finder, a browser…), which the composer may take. */
export function dragHasFiles(data: DataTransfer | null): boolean {
  return Array.from(data?.types ?? []).includes("Files");
}
