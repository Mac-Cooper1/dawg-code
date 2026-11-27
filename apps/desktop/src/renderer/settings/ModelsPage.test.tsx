import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DownloadState, HelperInfo, ModelsState, ResolvedTheme } from "../../shared/bridge.ts";
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
    setHelperEnabled: vi.fn(done),
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

const HELPER_ID = "minicpm5-1b-q8";
const HELPER_NAME = "MiniCPM5 1B (8-bit)";

/** A models state whose helper differs from the mock's by `patch`. */
function withHelper(state: ModelsState, patch: Partial<HelperInfo>): ModelsState {
  if (!state.helper) throw new Error("The mock state has no helper");
  return { ...state, helper: { ...state.helper, ...patch } };
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

  it("shows the helper model running beside the main model, with its switch", async () => {
    const { actions, user } = setup(theme);
    const region = screen.getByRole("region", { name: "Helper model" });
    const helper = section("Helper model");
    expect(within(helper).getByText(HELPER_NAME)).toBeInTheDocument();
    expect(within(helper).getByText("Running")).toBeInTheDocument();
    expect(helper).toHaveTextContent(
      "A small model that writes session titles and summarises web pages, so your main model stays free for the conversation.",
    );
    expect(helper).toHaveTextContent(
      "1.2 GB · uses about 2.3 GB of memory · 32K tokens · Apache-2.0",
    );
    expect(helper).toHaveTextContent(
      "Answering titles and page summaries · using 1.8 GB of memory",
    );
    await user.click(
      within(helper).getByRole("button", { name: `Read the Apache-2.0 licence of ${HELPER_NAME}` }),
    );
    expect(actions.openExternal).toHaveBeenCalledWith(
      "https://github.com/OpenBMB/MiniCPM/blob/main/LICENSE",
    );

    // The switch: named by its title, described by what it does now, reachable by keyboard.
    const toggle = within(region).getByRole("switch", { name: "Use the helper for side requests" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleDescription("Titles and page summaries go to the helper model.");
    toggle.focus();
    await user.keyboard(" ");
    expect(actions.setHelperEnabled).toHaveBeenCalledWith(false);

    // Remove asks first, as the other deletions do.
    await user.click(within(helper).getByRole("button", { name: `Remove ${HELPER_NAME}` }));
    const dialog = await screen.findByRole("alertdialog", { name: `Remove ${HELPER_NAME}?` });
    expect(dialog).toHaveTextContent(
      "It stops, and the copy dawg downloaded (1.2 GB) is deleted from this Mac. Titles and page summaries go to the main model until you download it again.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(actions.removeModel).toHaveBeenCalledWith(HELPER_ID);
  });

  it("offers the helper for download, or the copy another app has", async () => {
    const { actions, user } = setup(theme, withHelper(mockModelsState("empty"), {}));
    const helper = section("Helper model");
    expect(within(helper).getByText("Not downloaded")).toBeInTheDocument();
    await user.click(
      within(helper).getByRole("button", { name: `Download ${HELPER_NAME}, 1.2 GB` }),
    );
    expect(actions.downloadModel).toHaveBeenCalledWith(HELPER_ID);
    expect(within(helper).queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  });

  it("uses another app's copy of the helper instead of downloading it", async () => {
    const { actions, user } = setup(
      theme,
      withHelper(mockModelsState("empty"), { foundIn: "lmstudio" }),
    );
    const helper = section("Helper model");
    expect(within(helper).getByText("Found in LM Studio")).toBeInTheDocument();
    await user.click(within(helper).getByRole("button", { name: "Use the copy from LM Studio" }));
    expect(actions.adoptExistingModel).toHaveBeenCalledWith(HELPER_ID);
  });

  it("says why the helper does not fit, and keeps Download off", () => {
    setup(theme, mockModelsState("small"));
    const helper = section("Helper model");
    expect(within(helper).getByText("Does not fit")).toBeInTheDocument();
    const button = within(helper).getByRole("button", { name: `Download ${HELPER_NAME}, 1.2 GB` });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Needs 48 GB of memory; this Mac has 16 GB.");
  });

  it("shows the helper's download in its own section, with pause and cancel", async () => {
    const state = withHelper(mockModelsState("empty"), { state: "downloading" });
    const { actions, user } = setup(theme, {
      ...state,
      downloads: [
        download({
          modelId: HELPER_ID,
          bytesDone: 576_764_608,
          bytesTotal: 1_153_529_216,
          bytesPerSecond: 50_000_000,
          secondsLeft: 12,
        }),
      ],
    });
    const helper = section("Helper model");
    expect(within(helper).getByText("Downloading")).toBeInTheDocument();
    expect(
      within(helper).getByRole("progressbar", { name: `Downloading ${HELPER_NAME}` }),
    ).toHaveAttribute("aria-valuenow", "50");
    expect(helper).toHaveTextContent("50.0% · 577 MB of 1.2 GB");
    // Not listed again under Downloads.
    expect(screen.queryByRole("heading", { level: 2, name: "Downloads" })).not.toBeInTheDocument();
    await user.click(
      within(helper).getByRole("button", { name: `Pause downloading ${HELPER_NAME}` }),
    );
    expect(actions.pauseDownload).toHaveBeenCalledWith(HELPER_ID);
    await user.click(within(helper).getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: `Cancel the download of ${HELPER_NAME}?`,
    });
    await user.click(within(dialog).getByRole("button", { name: "Cancel download" }));
    expect(actions.cancelDownload).toHaveBeenCalledWith(HELPER_ID);
  });

  it.each([
    ["paused", "Paused", "Resume"],
    ["failed", "Download failed", "Retry"],
  ] as const)("a %s helper download can carry on", async (phase, tag, button) => {
    const state = withHelper(mockModelsState("empty"), { state: phase });
    const { actions, user } = setup(theme, {
      ...state,
      downloads: [
        download({
          modelId: HELPER_ID,
          phase,
          bytesDone: 300_000_000,
          bytesTotal: 1_153_529_216,
          error: phase === "failed" ? "Hugging Face did not answer." : null,
        }),
      ],
    });
    const helper = section("Helper model");
    expect(within(helper).getByText(tag)).toBeInTheDocument();
    await user.click(within(helper).getByRole("button", { name: button }));
    expect(actions.downloadModel).toHaveBeenCalledWith(HELPER_ID);
  });

  it.each([
    ["ready", "Ready", "Downloaded. It starts with your model."],
    ["starting", "Starting", "Loading into memory"],
  ] as const)("says the helper is %s", (helperState, tag, line) => {
    setup(theme, withHelper(mockModelsState(), { state: helperState, runtimeMemoryBytes: null }));
    const helper = section("Helper model");
    expect(within(helper).getByText(tag)).toBeInTheDocument();
    expect(helper).toHaveTextContent(line);
  });

  it("says why the helper could not start", () => {
    setup(
      theme,
      withHelper(mockModelsState(), {
        state: "error",
        runtimeMemoryBytes: null,
        message: "The helper model could not start, so the main model answers side requests.",
      }),
    );
    const helper = section("Helper model");
    expect(within(helper).getByText("Could not start")).toBeInTheDocument();
    expect(within(helper).getByRole("status")).toHaveTextContent(
      "The helper model could not start, so the main model answers side requests.",
    );
  });

  it("turned off, the main model answers side requests", async () => {
    const { actions, user } = setup(
      theme,
      withHelper(mockModelsState(), {
        state: "ready",
        enabled: false,
        runtimeMemoryBytes: null,
        message: "Turned off: the main model answers titles and page summaries",
      }),
    );
    const helper = section("Helper model");
    expect(helper).toHaveTextContent(
      "Turned off: the main model answers titles and page summaries",
    );
    const toggle = within(helper).getByRole("switch", { name: "Use the helper for side requests" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleDescription("The main model answers titles and page summaries.");
    await user.click(toggle);
    expect(actions.setHelperEnabled).toHaveBeenCalledWith(true);
  });

  it("has no helper section when the catalog has no helper", () => {
    setup(theme, { ...mockModelsState(), helper: null });
    expect(screen.queryByRole("heading", { name: "Helper model" })).not.toBeInTheDocument();
  });

  it("says it is looking while the models state loads", () => {
    setup(theme, null);
    expect(screen.getByText("Looking at this Mac…")).toBeInTheDocument();
  });
});
