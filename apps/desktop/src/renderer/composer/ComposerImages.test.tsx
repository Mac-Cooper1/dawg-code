import type { FileMention } from "@dawg/protocol";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedTheme } from "../../shared/bridge.ts";
import { sampleComposer, TEST_MODELS } from "../app/testing.tsx";
import type { ComposerView, ImageAttachment } from "../state/types.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { Composer } from "./Composer.tsx";
import { fittedSize, ImageRefused, MAX_IMAGE_BYTES, prepareImage } from "./images.ts";

// --- A pretend image decoder and canvas (jsdom has neither) -------------------------------------

interface Picture {
  width: number;
  height: number;
  /** Fails to decode, as a corrupt file does. */
  broken?: boolean;
}

const pictures = new WeakMap<Blob, Picture>();
/** What the canvas encodes to, by type. */
let encodedBytes: Record<string, number> = {};
/** Whether the canvas's pixels are all opaque. */
let opaque = true;
/** Decoding waits for this, when set. */
let decodeGate: Promise<void> | null = null;
const canvases: FakeCanvas[] = [];

class FakeCanvas {
  readonly width: number;
  readonly height: number;
  readonly drawn: unknown[][] = [];
  readonly encoded: { type: string; quality?: number }[] = [];
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    canvases.push(this);
  }
  getContext() {
    return {
      drawImage: (...args: unknown[]) => this.drawn.push(args),
      getImageData: () => ({ data: new Uint8ClampedArray([9, 9, 9, opaque ? 255 : 128]) }),
    };
  }
  async convertToBlob(options: { type: string; quality?: number }) {
    this.encoded.push(options);
    return new Blob([new Uint8Array(encodedBytes[options.type] ?? 10)], { type: options.type });
  }
}

beforeEach(() => {
  encodedBytes = { "image/png": 2000, "image/jpeg": 1000 };
  opaque = true;
  decodeGate = null;
  canvases.length = 0;
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
    if (decodeGate) await decodeGate;
    const picture = pictures.get(blob);
    if (!picture || picture.broken) throw new Error("The source image could not be decoded.");
    return { width: picture.width, height: picture.height, close: vi.fn() };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function imageFile(
  name: string,
  type: string,
  picture: Picture & { bytes?: number; size?: number },
): File {
  const file = new File([new Uint8Array(picture.bytes ?? 64).fill(7)], name, { type });
  if (picture.size !== undefined) Object.defineProperty(file, "size", { value: picture.size });
  pictures.set(file, picture);
  return file;
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

// --- prepareImage ------------------------------------------------------------------------------

describe("prepareImage", () => {
  it("fits the longest side within 2048 pixels", () => {
    expect(fittedSize(4000, 3000)).toEqual({ width: 2048, height: 1536 });
    expect(fittedSize(1000, 5000)).toEqual({ width: 410, height: 2048 });
    expect(fittedSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("sends a small image as it is", async () => {
    const file = imageFile("shot.png", "image/png", { width: 800, height: 600, bytes: 32 });
    const image = await prepareImage(file, "i1");
    expect(image).toEqual({
      id: "i1",
      name: "shot.png",
      mediaType: "image/png",
      data: base64(new Uint8Array(32).fill(7)),
      width: 800,
      height: 600,
    });
    expect(canvases).toHaveLength(0);
  });

  it("downscales a large image, and makes a big opaque PNG a JPEG when that is much smaller", async () => {
    encodedBytes = { "image/png": 3_000_000, "image/jpeg": 900_000 };
    const file = imageFile("photo.png", "image/png", { width: 4000, height: 3000 });
    const image = await prepareImage(file, "i1");
    expect(image).toMatchObject({ mediaType: "image/jpeg", width: 2048, height: 1536 });
    expect(image.data.length).toBe(Math.ceil(900_000 / 3) * 4);
    const [canvas] = canvases;
    expect(canvas).toMatchObject({ width: 2048, height: 1536 });
    expect(canvas?.drawn[0]?.slice(1)).toEqual([0, 0, 2048, 1536]);
    expect(canvas?.encoded).toEqual([{ type: "image/png" }, { type: "image/jpeg", quality: 0.85 }]);
  });

  it("keeps a PNG with transparency, or one JPEG would not shrink enough, as PNG", async () => {
    encodedBytes = { "image/png": 3_000_000, "image/jpeg": 900_000 };
    opaque = false;
    const clear = await prepareImage(
      imageFile("logo.png", "image/png", { width: 3000, height: 3000 }),
      "i1",
    );
    expect(clear.mediaType).toBe("image/png");
    opaque = true;
    encodedBytes = { "image/png": 3_000_000, "image/jpeg": 2_000_000 };
    const busy = await prepareImage(
      imageFile("chart.png", "image/png", { width: 3000, height: 3000 }),
      "i2",
    );
    expect(busy.mediaType).toBe("image/png");
  });

  it("re-encodes WebP, and a resized JPEG stays JPEG", async () => {
    const webp = await prepareImage(
      imageFile("pic.webp", "image/webp", { width: 500, height: 400 }),
      "i1",
    );
    expect(webp).toMatchObject({ mediaType: "image/png", width: 500, height: 400 });
    const jpeg = await prepareImage(
      imageFile("cam.jpg", "image/jpeg", { width: 6000, height: 4000 }),
      "i2",
    );
    expect(jpeg).toMatchObject({ mediaType: "image/jpeg", width: 2048, height: 1365 });
    expect(canvases.at(-1)?.encoded).toEqual([{ type: "image/jpeg", quality: 0.9 }]);
  });

  it("refuses other types, files over 20 MB and files it cannot read", async () => {
    await expect(
      prepareImage(imageFile("notes.txt", "text/plain", { width: 1, height: 1 }), "i"),
    ).rejects.toThrow("notes.txt was not attached: only PNG, JPEG, GIF and WebP images can be.");
    await expect(
      prepareImage(
        imageFile("huge.png", "image/png", { width: 1, height: 1, size: MAX_IMAGE_BYTES + 1 }),
        "i",
      ),
    ).rejects.toThrow("huge.png was not attached: it is over 20 MB.");
    const broken = prepareImage(
      imageFile("bad.png", "image/png", { width: 1, height: 1, broken: true }),
      "i",
    );
    await expect(broken).rejects.toBeInstanceOf(ImageRefused);
    await expect(broken).rejects.toThrow(
      "bad.png was not attached: it could not be read as an image.",
    );
  });
});

// --- The composer ------------------------------------------------------------------------------

interface Spies {
  onSubmit: ReturnType<typeof vi.fn<(text: string, mentions?: FileMention[]) => void>>;
  onAddAttachments: ReturnType<typeof vi.fn<(images: ImageAttachment[]) => void>>;
}

/** Holds the draft and the attached images, as the store does. */
function Harness(props: { view: ComposerView; spies: Spies; initial?: ImageAttachment[] }) {
  const [draft, setDraft] = useState(props.view.draft);
  const [images, setImages] = useState<ImageAttachment[]>(props.initial ?? []);
  return (
    <Composer
      view={{ ...props.view, draft }}
      models={TEST_MODELS}
      canSend
      attachments={images}
      mentionPaths={[]}
      onDraftChange={setDraft}
      onSubmit={(text, mentions) => {
        props.spies.onSubmit(text, mentions);
        setDraft("");
        setImages([]);
      }}
      onFindFiles={async () => ({ matches: [], truncated: false })}
      onAddAttachments={(added) => {
        props.spies.onAddAttachments(added);
        setImages((current) => [...current, ...added]);
      }}
      onRemoveAttachment={(id) => setImages((current) => current.filter((i) => i.id !== id))}
      onRememberMention={vi.fn()}
      onInterrupt={vi.fn()}
      onSetMode={vi.fn()}
      onCycleMode={vi.fn()}
      onSetModel={vi.fn()}
      onSetEffort={vi.fn()}
      onCompact={vi.fn()}
      onSendQueuedNow={vi.fn()}
      onRemoveQueued={vi.fn()}
      onManageModels={vi.fn()}
    />
  );
}

function setup(
  theme: ResolvedTheme,
  options: { view?: Partial<ComposerView>; initial?: ImageAttachment[] } = {},
) {
  const spies: Spies = { onSubmit: vi.fn(), onAddAttachments: vi.fn() };
  renderInTheme(
    <Harness view={sampleComposer(options.view)} spies={spies} initial={options.initial} />,
    theme,
  );
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const textbox = screen.getByRole("textbox", { name: "Message to dawg" });
  const box = textbox.parentElement as HTMLElement;
  return { spies, user, textbox, box };
}

/** What a paste or drop carries. */
function transfer(files: File[], extra: Record<string, string> = {}) {
  const types = [...(files.length > 0 ? ["Files"] : []), ...Object.keys(extra)];
  return { files, types, getData: (type: string) => extra[type] ?? "" };
}

function thumbnails(): string[] {
  const list = screen.queryByRole("list", { name: "Attached images" });
  if (!list) return [];
  return within(list)
    .queryAllByRole("img")
    .map((image) => image.getAttribute("alt") ?? "");
}

function attached(name: string): ImageAttachment {
  return { id: `id-${name}`, name, mediaType: "image/png", data: "AAAA", width: 10, height: 10 };
}

describe.each(THEMES)("attaching images (%s)", (theme) => {
  it("attaches a pasted image, shows it, and removes it from the keyboard", async () => {
    const { spies, user, textbox } = setup(theme);
    const file = imageFile("Screenshot.png", "image/png", { width: 1200, height: 800 });
    fireEvent.paste(textbox, { clipboardData: transfer([file]) });
    await waitFor(() => expect(thumbnails()).toEqual(["Screenshot.png"]));
    expect(spies.onAddAttachments).toHaveBeenCalledOnce();
    expect(textbox).toHaveValue("");
    const image = screen.getByRole("img", { name: "Screenshot.png" });
    expect(image.getAttribute("src")).toMatch(/^data:image\/png;base64,/);

    const remove = screen.getByRole("button", { name: "Remove Screenshot.png" });
    remove.focus();
    await user.keyboard("{Enter}");
    expect(thumbnails()).toEqual([]);
    expect(textbox).toHaveFocus();
  });

  it("pastes text as text, also an office app's copy that carries a picture of it", async () => {
    const { spies, textbox } = setup(theme);
    const picture = imageFile("cells.png", "image/png", { width: 10, height: 10 });
    const event = fireEvent.paste(textbox, {
      clipboardData: transfer([picture], { "text/plain": "a\tb", "text/html": "<table/>" }),
    });
    expect(event).toBe(true);
    expect(spies.onAddAttachments).not.toHaveBeenCalled();
  });

  it("highlights the box while files are dragged over it, and attaches what is dropped", async () => {
    const { box } = setup(theme);
    const file = imageFile("diagram.jpg", "image/jpeg", { width: 640, height: 480 });
    fireEvent.dragEnter(box, { dataTransfer: transfer([file]) });
    expect(box).toHaveAttribute("data-dropping", "yes");
    expect(box).toHaveTextContent("Drop images to attach them");
    fireEvent.dragLeave(box, { dataTransfer: transfer([file]) });
    expect(box).not.toHaveAttribute("data-dropping");

    fireEvent.dragEnter(box, { dataTransfer: transfer([file]) });
    fireEvent.drop(box, { dataTransfer: transfer([file]) });
    expect(box).not.toHaveAttribute("data-dropping");
    await waitFor(() => expect(thumbnails()).toEqual(["diagram.jpg"]));
  });

  it("leaves a drag of text alone", () => {
    const { box } = setup(theme);
    fireEvent.dragEnter(box, { dataTransfer: transfer([], { "text/plain": "hello" }) });
    expect(box).not.toHaveAttribute("data-dropping");
  });

  it("attaches through the attach button's file picker", async () => {
    const { user } = setup(theme);
    const input = screen.getByTestId("attach-input");
    expect(input).toHaveAttribute("accept", "image/png,image/jpeg,image/gif,image/webp");
    expect(input).toHaveAttribute("type", "file");
    const files = [
      imageFile("a.png", "image/png", { width: 10, height: 10 }),
      imageFile("b.gif", "image/gif", { width: 10, height: 10 }),
    ];
    await user.upload(input, files);
    await waitFor(() => expect(thumbnails()).toEqual(["a.png", "b.gif"]));
  });

  it("says in one line why a file was not attached", async () => {
    const { textbox } = setup(theme);
    fireEvent.paste(textbox, {
      clipboardData: transfer([new File(["x"], "notes.txt", { type: "text/plain" })]),
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "notes.txt was not attached: only PNG, JPEG, GIF and WebP images can be.",
    );
    fireEvent.paste(textbox, {
      clipboardData: transfer([
        imageFile("huge.png", "image/png", { width: 1, height: 1, size: 25 * 1024 * 1024 }),
      ]),
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "huge.png was not attached: it is over 20 MB.",
      ),
    );
    expect(thumbnails()).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps a message to ten images", async () => {
    const { box } = setup(theme, { initial: [attached("one.png"), attached("two.png")] });
    const files = Array.from({ length: 10 }, (_, i) =>
      imageFile(`p${i}.png`, "image/png", { width: 10, height: 10 }),
    );
    fireEvent.drop(box, { dataTransfer: transfer(files) });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "A message can have up to 10 images.",
    );
    await waitFor(() => expect(thumbnails()).toHaveLength(10));
    expect(thumbnails().slice(2)).toEqual([
      "p0.png",
      "p1.png",
      "p2.png",
      "p3.png",
      "p4.png",
      "p5.png",
      "p6.png",
      "p7.png",
    ]);
    expect(screen.getByRole("button", { name: "Attach images" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("says the model cannot view images instead of attaching", async () => {
    const { spies, textbox, box } = setup(theme, { view: { canAttachImages: false } });
    const file = imageFile("shot.png", "image/png", { width: 10, height: 10 });
    fireEvent.paste(textbox, { clipboardData: transfer([file]) });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Qwen3.8 27B · 8-bit can't view images, so nothing was attached.",
    );
    fireEvent.dragEnter(box, { dataTransfer: transfer([file]) });
    expect(box).toHaveAttribute("data-dropping", "no");
    expect(box).toHaveTextContent("Qwen3.8 27B · 8-bit can't view images");
    fireEvent.drop(box, { dataTransfer: transfer([file]) });
    expect(spies.onAddAttachments).not.toHaveBeenCalled();
    expect(thumbnails()).toEqual([]);
  });

  it("sends images without text, but not before they are ready", async () => {
    const { spies, user, textbox } = setup(theme);
    let open: () => void = () => {};
    decodeGate = new Promise((resolve) => {
      open = resolve;
    });
    fireEvent.paste(textbox, {
      clipboardData: transfer([imageFile("shot.png", "image/png", { width: 10, height: 10 })]),
    });
    expect(await screen.findByRole("status", { name: "Preparing an image" })).toBeInTheDocument();
    textbox.focus();
    await user.keyboard("{Enter}");
    expect(spies.onSubmit).not.toHaveBeenCalled();
    await act(async () => open());
    await waitFor(() => expect(thumbnails()).toEqual(["shot.png"]));
    await user.keyboard("{Enter}");
    expect(spies.onSubmit).toHaveBeenCalledWith("", undefined);
    expect(thumbnails()).toEqual([]);
  });
});
