/**
 * File types the text tools do not handle, told apart by extension before anything is read.
 */
import path from "node:path";

interface BinaryKind {
  /** What the file is, for the message: "a zip archive". */
  label: string;
  /** A shell command that shows something useful about it; `{}` stands for the path. */
  hint: string;
}

const ARCHIVE: BinaryKind = {
  label: "an archive",
  hint: "list it with `tar -tf {}` or `unzip -l {}`",
};
const OFFICE: BinaryKind = {
  label: "an office document",
  hint: "convert it to text with a script, for example Python with a library for that format",
};
const MEDIA: BinaryKind = { label: "an audio or video file", hint: "inspect it with `file {}`" };
const FONT: BinaryKind = { label: "a font file", hint: "inspect it with `file {}`" };
const COMPILED: BinaryKind = {
  label: "compiled or executable code",
  hint: "inspect it with `file {}`, or list its symbols with `nm {}`",
};
const DATABASE: BinaryKind = {
  label: "a database file",
  hint: "query it with `sqlite3 {} .tables` if it is SQLite",
};
const DATA: BinaryKind = {
  label: "a binary data file",
  hint: "read it with a script that understands the format",
};
const OTHER_IMAGE: BinaryKind = {
  label: "an image format that Read cannot show",
  hint: "convert it to PNG first, for example with `sips -s format png {} --out /tmp/out.png`",
};

const BINARY_EXTENSIONS: ReadonlyMap<string, BinaryKind> = new Map([
  ...[".zip", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".7z", ".rar", ".tar", ".jar", ".war"].map(
    (e) => [e, ARCHIVE] as const,
  ),
  ...[".xlsx", ".xls", ".docx", ".doc", ".pptx", ".ppt", ".odt", ".ods", ".odp"].map(
    (e) => [e, OFFICE] as const,
  ),
  ...[".mp3", ".mp4", ".m4a", ".m4v", ".mov", ".avi", ".mkv", ".wav", ".flac", ".ogg", ".webm"].map(
    (e) => [e, MEDIA] as const,
  ),
  ...[".ttf", ".otf", ".woff", ".woff2", ".eot"].map((e) => [e, FONT] as const),
  ...[".exe", ".dll", ".so", ".dylib", ".o", ".a", ".class", ".pyc", ".wasm", ".node"].map(
    (e) => [e, COMPILED] as const,
  ),
  ...[".sqlite", ".sqlite3", ".db"].map((e) => [e, DATABASE] as const),
  ...[".parquet", ".avro", ".orc", ".npy", ".npz", ".pkl", ".pickle", ".bin"].map(
    (e) => [e, DATA] as const,
  ),
  ...[".heic", ".heif", ".tif", ".tiff", ".bmp", ".ico", ".icns", ".psd"].map(
    (e) => [e, OTHER_IMAGE] as const,
  ),
  [".dmg", { label: "a disk image", hint: "mount it with `hdiutil attach {}`" }],
  [".iso", { label: "a disk image", hint: "inspect it with `file {}`" }],
]);

export function binaryKindFor(filePath: string): BinaryKind | null {
  return BINARY_EXTENSIONS.get(path.extname(filePath).toLowerCase()) ?? null;
}

export function binaryHint(kind: BinaryKind, filePath: string): string {
  return kind.hint.replaceAll("{}", shellQuote(filePath));
}

export type UnsupportedKind = "pdf" | "notebook";

export function unsupportedKindFor(filePath: string): UnsupportedKind | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".ipynb") return "notebook";
  return null;
}

/** Quotes a path for a shell command shown to the model, only when it needs it. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./~+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
