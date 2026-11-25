import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DownloadState, ModelsState, ResolvedTheme } from "../../shared/bridge.ts";
import { mockModelsState } from "../../shared/mock-models.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { ModelsPage, type ModelsPageActions } from "./ModelsPage.tsx";

function fakeActions(): {
  [K in keyof ModelsPageActions]: ReturnType<typeof vi.fn>;
} & ModelsPageActions {
  const done = async () => {};
  return {
    startModel: vi.fn(done),
    stopModel: vi.fn(done),
    setDefaultModel: vi.fn(done),
    removeModel: vi.fn(done),
    setIdleUnload: vi.fn(done),
    downloadModel: vi.fn(done),
    pauseDownload: vi.fn(done),
    cancelDownload: vi.fn(done),
    dismissDownload: vi.fn(done),
    adoptExistingModel: vi.fn(done),
    addModelFile: vi.fn(async () => ({
      option: {
        id: "file:abc123",
        label: "tiny-Q8_0.gguf",
        shortLabel: "tiny · Q8_0",
        description: "Model file · ~/Models/tiny-Q8_0.gguf",
        source: "bundled" as const,
        contextWindow: 8192,
        origin: "file" as const,
        removable: false,
      },
      memoryWarning: "This model may need more memory than this Mac has (about 70 GB).",
    })),
    connectServer: vi.fn(async () => ({ error: "Could not reach it: connection refused." })),
    removeServer: vi.fn(done),
    refreshServers: vi.fn(done),
    openExternal: vi.fn(done),
  };
}

function download(patch: Partial<DownloadState>): DownloadState {
  return {
    modelId: "qwen3.6-122b-a10b-q6",
    phase: "downloading",
    bytesDone: 0,
    bytesTotal: 100_200_000_000,
    bytesPerSecond: 0,
    secondsLeft: null,
    error: null,
    ...patch,
  };
}

function setup(theme: ResolvedTheme, state: ModelsState | null = mockModelsState()) {
  const actions = fakeActions();
  renderInTheme(<ModelsPage state={state} actions={actions} />, theme);
  return { actions, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}

function section(name: string): HTMLElement {
  const heading = screen.getByRole("heading", { level: 2, name: new RegExp(`^${name}`) });
  const card = heading.nextElementSibling;
  if (!(card instanceof HTMLElement)) throw new Error(`No card after ${name}`);
  return card;
}

describe.each(THEMES)("Settings → Models (%s)", (theme) => {
  it("shows the running model, its memory and Stop", async () => {
    const { actions, user } = setup(theme);
    expect(screen.getByRole("heading", { level: 1, name: "Models" })).toBeInTheDocument();
    const running = section("Running now");
    expect(within(running).getByText("Qwen3.8 27B · 8-bit")).toBeInTheDocument();
    expect(within(running).getByText("Ready")).toBeInTheDocument();
    const meter = within(running).getByRole("meter", { name: "Memory the model uses" });
    expect(meter).toHaveAttribute("aria-valuetext", "29.3 GB of 64 GB");
    expect(within(running).getByText("34.7 GB left of 64 GB")).toBeInTheDocument();
    await user.click(within(running).getByRole("button", { name: "Stop" }));
    expect(actions.stopModel).toHaveBeenCalledOnce();
  });

  it("starts the default model when nothing runs, and sets idle unload", async () => {
    const state = mockModelsState();
    const { actions, user } = setup(theme, {
      ...state,
      status: {
        state: "stopped",
        modelId: null,
        label: null,
        message: "Stopped",
        memoryBytes: null,
      },
    });
    const running = section("Running now");
    expect(within(running).getByText("Nothing running")).toBeInTheDocument();
    expect(running).toHaveTextContent("Start loads Qwen3.8 27B (8-bit).");
    expect(within(running).queryByRole("meter")).not.toBeInTheDocument();
    await user.click(within(running).getByRole("button", { name: "Start" }));
    expect(actions.startModel).toHaveBeenCalledWith("qwen3.8-27b-q8");

    const idle = within(running).getByRole("combobox", {
      name: /Unload the model after it sits idle/,
    });
    expect(idle).toHaveValue("never");
    await user.selectOptions(idle, "After 30 minutes");
    expect(actions.setIdleUnload).toHaveBeenCalledWith(30);
    await user.selectOptions(idle, "Never");
    expect(actions.setIdleUnload).toHaveBeenLastCalledWith(null);
  });

  it("shows a load that failed", () => {
    setup(theme, {
      ...mockModelsState(),
      status: {
        state: "error",
        modelId: null,
        label: null,
        message: "llama-server exited three times while loading",
        memoryBytes: null,
      },
    });
    const running = section("Running now");
    expect(within(running).getByText("Error")).toBeInTheDocument();
    expect(running).toHaveTextContent("llama-server exited three times while loading");
  });

  it("lists the models on this Mac: the default, start, make default, delete after asking", async () => {
    const { actions, user } = setup(theme);
    const mac = section("On this Mac");
    expect(within(mac).getByText("Default")).toBeInTheDocument();
    expect(
      within(mac).queryByRole("button", { name: /Make Qwen3.8 27B \(8-bit\) the default/ }),
    ).toBeNull();
    // Server models are listed under their server, not here.
    expect(within(mac).queryByText("Ollama · qwen3.6:35b-a3b")).toBeNull();

    await user.click(
      within(mac).getByRole("button", { name: "Make Qwen3.8 27B (6-bit) the default" }),
    );
    expect(actions.setDefaultModel).toHaveBeenCalledWith("qwen3.8-27b-q6");
    await user.click(within(mac).getByRole("button", { name: "Start gpt-oss 20B (4-bit)" }));
    expect(actions.startModel).toHaveBeenCalledWith("gpt-oss-20b-q4");
    // Another app's copy is not dawg's to delete.
    expect(within(mac).queryByRole("button", { name: "Delete gpt-oss 20B (4-bit)" })).toBeNull();

    await user.click(within(mac).getByRole("button", { name: "Delete Qwen3.8 27B (6-bit)" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete Qwen3.8 27B (6-bit)?" });
    expect(dialog).toHaveTextContent("Its 22.9 GB of files are deleted from this Mac.");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(actions.removeModel).toHaveBeenCalledWith("qwen3.8-27b-q6");
  });

  it("adds a model file and shows its memory warning", async () => {
    const { actions, user } = setup(theme);
    await user.click(screen.getByRole("button", { name: "Add a model file (.gguf)…" }));
    expect(actions.addModelFile).toHaveBeenCalledOnce();
    expect(await screen.findByText("Added tiny-Q8_0.gguf")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "This model may need more memory than this Mac has (about 70 GB).",
    );
  });

  it("shows downloads with their controls", async () => {
    const state = mockModelsState();
    const { actions, user } = setup(theme, {
      ...state,
      downloads: [
        download({
          bytesDone: 40_000_000_000,
          bytesPerSecond: 80_000_000,
          secondsLeft: 752,
        }),
        download({
          modelId: "qwen3.8-27b-q6",
          phase: "paused",
          bytesDone: 5_000_000_000,
          bytesTotal: 22_900_000_000,
        }),
        download({
          modelId: "gpt-oss-20b-q4",
          phase: "failed",
          bytesDone: 1_000_000_000,
          bytesTotal: 11_600_000_000,
          error: "The file did not match its SHA-256 and was deleted.",
        }),
      ],
    });
    const downloads = section("Downloads");
    const rows = within(downloads).getAllByRole("progressbar");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute("aria-valuenow", "40");
    expect(downloads).toHaveTextContent("40.0 of 100 GB · 80 MB/s · about 12 min 32 s left");
    expect(downloads).toHaveTextContent("Paused at 5.0 of 22.9 GB · resumes where it stopped");
    expect(within(downloads).getByRole("alert")).toHaveTextContent(
      "The file did not match its SHA-256 and was deleted.",
    );

    await user.click(within(downloads).getByRole("button", { name: "Pause" }));
    expect(actions.pauseDownload).toHaveBeenCalledWith("qwen3.6-122b-a10b-q6");
    await user.click(within(downloads).getByRole("button", { name: "Resume" }));
    expect(actions.downloadModel).toHaveBeenCalledWith("qwen3.8-27b-q6");
    await user.click(within(downloads).getByRole("button", { name: "Retry" }));
    expect(actions.downloadModel).toHaveBeenLastCalledWith("gpt-oss-20b-q4");
    await user.click(
      within(downloads).getByRole("button", { name: "Clear gpt-oss 20B (4-bit) from the list" }),
    );
    expect(actions.dismissDownload).toHaveBeenCalledWith("gpt-oss-20b-q4");

    await user.click(
      within(downloads).getAllByRole("button", { name: "Cancel" })[0] as HTMLElement,
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "Cancel the download of Qwen3.6 122B-A10B (6-bit)?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Cancel download" }));
    expect(actions.cancelDownload).toHaveBeenCalledWith("qwen3.6-122b-a10b-q6");
  });

  it("offers catalog models with their size and fit", async () => {
    const empty = mockModelsState("empty");
    const { actions, user } = setup(theme, empty);
    const available = section("Available for this Mac");
    expect(within(available).getByText("Recommended")).toBeInTheDocument();
    await user.click(
      within(available).getByRole("button", { name: "Download Qwen3.8 27B (8-bit), 30.0 GB" }),
    );
    expect(actions.downloadModel).toHaveBeenCalledWith("qwen3.8-27b-q8");
    const big = within(available).getByRole("button", {
      name: "Download Qwen3.6 122B-A10B (6-bit), 100 GB",
    });
    expect(big).toBeDisabled();
    expect(big).toHaveAccessibleDescription("Needs 104 GB of memory; this Mac has 64 GB.");
    await user.click(
      within(available).getByRole("button", { name: "Use the copy from LM Studio" }),
    );
    expect(actions.adoptExistingModel).toHaveBeenCalledWith("gpt-oss-20b-q4");
    await user.click(
      within(available).getByRole("button", {
        name: "Read the Apache-2.0 licence of Qwen3.8 27B (8-bit)",
      }),
    );
    expect(actions.openExternal).toHaveBeenCalledWith(
      "https://www.apache.org/licenses/LICENSE-2.0",
    );
    expect(
      within(section("On this Mac")).getByText(/No models on this Mac yet/),
    ).toBeInTheDocument();
  });

  it("lists servers, looks again, removes a remote one after asking, and adds one", async () => {
    const state = mockModelsState();
    const { actions, user } = setup(theme, {
      ...state,
      servers: [
        ...state.servers,
        {
          id: "remote:1f3a9c",
          kind: "remote",
          url: "https://studio.local:8080/v1",
          reachable: false,
          modelIds: [],
          hasKey: true,
        },
      ],
    });
    const servers = section("Servers");
    expect(within(servers).getByText("Ollama")).toBeInTheDocument();
    expect(within(servers).getByText("Running")).toBeInTheDocument();
    expect(within(servers).getByText("Not running")).toBeInTheDocument();
    expect(within(servers).getByText("Not answering")).toBeInTheDocument();
    expect(servers).toHaveTextContent("key in your Keychain");
    const ollamaModels = within(servers).getByRole("list", { name: "Models on Ollama" });
    await user.click(
      within(ollamaModels).getByRole("button", {
        name: "Make Ollama · qwen3.6:35b-a3b the default",
      }),
    );
    expect(actions.setDefaultModel).toHaveBeenCalledWith("ollama/qwen3.6:35b-a3b");

    await user.click(screen.getByRole("button", { name: "Look again" }));
    expect(actions.refreshServers).toHaveBeenCalledOnce();

    await user.click(within(servers).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove studio.local:8080?" });
    expect(dialog).toHaveTextContent("dawg forgets the server and the key in your Keychain.");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(actions.removeServer).toHaveBeenCalledWith("remote:1f3a9c");

    const form = screen.getByRole("form", { name: "Connect to a server" });
    await user.type(within(form).getByLabelText("OpenAI-compatible address"), "http://box:1234/v1");
    await user.type(within(form).getByLabelText("API key (optional)"), "sk-1");
    await user.click(within(form).getByRole("button", { name: "Add server" }));
    expect(actions.connectServer).toHaveBeenCalledWith({
      url: "http://box:1234/v1",
      apiKey: "sk-1",
    });
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "Could not reach it: connection refused.",
    );
  });

  it("says it is looking while the models state loads", () => {
    setup(theme, null);
    expect(screen.getByText("Looking at this Mac…")).toBeInTheDocument();
  });
});
