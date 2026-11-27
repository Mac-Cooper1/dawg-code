import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedTheme } from "../../shared/bridge.ts";
import { type MockModelsScenario, mockModelsState } from "../../shared/mock-models.ts";
import { App } from "../app/App.tsx";
import { PlatformProvider } from "../app/platform.tsx";
import { createMemoryBridge, type MemoryBridge } from "../bridge/index.ts";
import { type AppStoreApi, AppStoreProvider, createAppStore } from "../state/store.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";

const Q8 = "qwen3.8-27b-q8";
const Q8_NAME = "Qwen3.8 27B (8-bit)";

const open: { store: AppStoreApi; bridge: MemoryBridge }[] = [];

afterEach(() => {
  for (const { store, bridge } of open.splice(0)) {
    store.getState().actions.stop();
    bridge.modelManager.dispose();
  }
});

/**
 * The real store on the browser fallback bridge, its model manager driven by hand. The engine
 * never answers: first run does not need it.
 */
async function setup(theme: ResolvedTheme, scenario: MockModelsScenario = "empty") {
  const bridge = createMemoryBridge({
    storage: null,
    settings: { appearance: theme },
    modelsState: mockModelsState(scenario),
    modelTiming: { auto: false },
    engine: { connect: () => {} },
  });
  const openExternal = vi.spyOn(bridge.shell, "openExternal").mockResolvedValue();
  const store = createAppStore({ bridge });
  open.push({ store, bridge });
  renderInTheme(
    <PlatformProvider os="darwin">
      <AppStoreProvider store={store}>
        <App />
      </AppStoreProvider>
    </PlatformProvider>,
    theme,
  );
  void store.getState().actions.start();
  await screen.findByRole("list", { name: "Setup steps" });
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  return { bridge, store, user, manager: bridge.modelManager, openExternal };
}

function currentStep(): string | null {
  const steps = screen.getByRole("list", { name: "Setup steps" });
  const current = within(steps)
    .getAllByRole("listitem")
    .find((item) => item.getAttribute("aria-current") === "step");
  return current?.textContent ?? null;
}

describe.each(THEMES)("First run (%s)", (theme) => {
  it("welcomes with what it found about this Mac and the model to start with", async () => {
    const { user, openExternal } = await setup(theme);
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(currentStep()).toBe("1Choose a model");
    expect(
      screen.getByRole("heading", { level: 1, name: "A coding agent that runs on your Mac" }),
    ).toBeInTheDocument();
    // The app icon is decorative: the name sits next to it.
    expect(document.querySelector("img")).toHaveAttribute("alt", "");
    expect(screen.getByText("dawg-code")).toBeInTheDocument();

    const machine = screen.getByRole("region", { name: "What we found" });
    for (const text of ["Apple M4 Max", "64 GB", "1.21 TB", "macOS 26.1", "Apple silicon"]) {
      expect(within(machine).getByText(text)).toBeInTheDocument();
    }

    const lead = screen.getByRole("region", { name: Q8_NAME });
    expect(within(lead).getByText("Recommended for this Mac")).toBeInTheDocument();
    expect(within(lead).getByText("30.0 GB")).toBeInTheDocument();
    expect(within(lead).getByText("204,800 tokens")).toBeInTheDocument();
    expect(lead).toHaveTextContent(
      "Uses about 43 GB of this Mac’s 64 GB of memory while it runs. It uses tools, reads images and thinks before it answers.",
    );
    await user.click(within(lead).getByRole("button", { name: "Read the Apache-2.0 licence" }));
    expect(openExternal).toHaveBeenCalledWith("https://www.apache.org/licenses/LICENSE-2.0");
    expect(within(lead).getByRole("button", { name: "Download and start" })).toBeInTheDocument();
  });

  it("downloads with pause and resume, then starts the model and opens the sessions view", async () => {
    const { user, manager, store } = await setup(theme);
    await user.click(screen.getByRole("button", { name: "Download and start" }));
    const heading = await screen.findByRole("heading", {
      level: 1,
      name: `Downloading ${Q8_NAME}`,
    });
    expect(currentStep()).toBe("2Download");
    // The button that started it is gone: focus is on the new step's heading.
    expect(heading).toHaveFocus();

    act(() => manager.advanceDownload(Q8, 12_000_000_000));
    const bar = screen.getByRole("progressbar", { name: `Downloading ${Q8_NAME}` });
    expect(bar).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText("40.0%")).toBeInTheDocument();
    expect(
      screen.getByText(/12\.0 of 30\.0 GB · 1\.5 GB\/s · about 12 s left/),
    ).toBeInTheDocument();
    // VoiceOver hears the progress in tens, not every byte and speed change.
    expect(screen.getByText("Downloading, 40% done")).toHaveAttribute("aria-live", "polite");
    act(() => manager.advanceDownload(Q8, 300_000_000));
    expect(screen.getByText("Downloading, 40% done")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(
      await screen.findByText(/Paused at 12\.3 of 30\.0 GB · resumes where it stopped/),
    ).toBeInTheDocument();
    expect(screen.getByText("Download paused at 41%")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();

    act(() => manager.advanceDownload(Q8));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Starting the model" }),
    ).toBeInTheDocument();
    expect(currentStep()).toBe("3Start");
    expect(screen.getByText("Loading Qwen3.8 27B · 8-bit into memory")).toBeInTheDocument();
    expect(screen.getByText("about 43 GB")).toBeInTheDocument();

    act(() => manager.finishLoad());
    expect(await screen.findByRole("navigation", { name: "Sessions" })).toBeInTheDocument();
    expect(store.getState().modelsState?.defaultModelId).toBe(Q8);
  });

  it("asks before cancelling, then goes back to the welcome screen", async () => {
    const { user, manager } = await setup(theme);
    await user.click(screen.getByRole("button", { name: "Download and start" }));
    act(() => manager.advanceDownload(Q8, 3_000_000_000));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: `Cancel the download of ${Q8_NAME}?`,
    });
    expect(dialog).toHaveTextContent(
      "The 3.0 GB downloaded so far is deleted. Pause keeps it instead.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Keep downloading" }));
    expect(screen.getByRole("heading", { level: 1, name: `Downloading ${Q8_NAME}` })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Cancel download" }));
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "A coding agent that runs on your Mac",
      }),
    ).toBeInTheDocument();
  });

  it("shows a failed download's sentence, and retries from where it stopped", async () => {
    const { user, manager } = await setup(theme);
    await user.click(screen.getByRole("button", { name: "Download and start" }));
    act(() => manager.advanceDownload(Q8, 6_000_000_000));
    act(() => manager.failDownload(Q8, "Hugging Face did not answer. Check the connection."));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Hugging Face did not answer. Check the connection.",
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "20");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(manager.current().downloads[0]).toMatchObject({ bytesDone: 6_000_000_000 });

    act(() => manager.failDownload(Q8, "The download was corrupt and was deleted."));
    await user.click(await screen.findByRole("button", { name: "Choose another model" }));
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "A coding agent that runs on your Mac",
      }),
    ).toBeInTheDocument();
  });

  it("says why a model could not start, and tries again", async () => {
    const { user, manager } = await setup(theme);
    await user.click(screen.getByRole("button", { name: "Download and start" }));
    act(() => manager.advanceDownload(Q8));
    await screen.findByRole("heading", { level: 1, name: "Starting the model" });
    act(() => manager.finishLoad("Not enough free memory: quit some apps and try again"));
    expect(
      await screen.findByRole("heading", { level: 1, name: `Could not start ${Q8_NAME}` }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Not enough free memory: quit some apps and try again.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Starting the model" }),
    ).toBeInTheDocument();
    act(() => manager.finishLoad());
    expect(await screen.findByRole("navigation", { name: "Sessions" })).toBeInTheDocument();
  });

  it("offers the rest of the catalog with its fit, and another app's copy", async () => {
    const { user, manager } = await setup(theme);
    const more = screen.getByRole("button", { name: "More options" });
    await user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    const options = screen.getByRole("region", { name: "More options" });
    const big = within(options).getByRole("button", { name: "Download Qwen3.6 122B-A10B (6-bit)" });
    expect(big).toBeDisabled();
    expect(big).toHaveAccessibleDescription("Needs 104 GB of memory; this Mac has 64 GB.");
    expect(within(options).getByText("On this Mac already")).toBeInTheDocument();
    expect(options).toHaveTextContent("Found in LM Studio’s folder and used in place");

    await user.click(within(options).getByRole("button", { name: "Use the copy from LM Studio" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Starting the model" }),
    ).toBeInTheDocument();
    expect(manager.current().downloads).toEqual([]);
    act(() => manager.finishLoad());
    expect(await screen.findByRole("navigation", { name: "Sessions" })).toBeInTheDocument();
  });

  it("on a Mac nothing fits, says so and leads with a model file and a server", async () => {
    const { user } = await setup(theme, "small");
    expect(
      screen.getByRole("heading", { level: 2, name: "No catalog model fits this Mac" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The smallest needs 18 GB of memory; this Mac has 16 GB\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download and start" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add a model file…" }));
    const added = await screen.findByRole("region", { name: "Added model file" });
    expect(within(added).getByText("my-model-Q4_K_M.gguf")).toBeInTheDocument();
    expect(within(added).getByRole("status")).toHaveTextContent(
      "This model may need more memory than this Mac has (about 20 GB; this Mac has 16 GB).",
    );
    expect(within(added).getByRole("button", { name: "Start anyway" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Connect to a server…" }));
    const form = screen.getByRole("form", { name: "Connect to a server" });
    const address = within(form).getByLabelText("OpenAI-compatible address");
    expect(address).toHaveFocus();
    await user.type(address, "studio.local");
    await user.click(within(form).getByRole("button", { name: "Add server" }));
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "Enter an http or https address, such as http://studio.local:8080/v1.",
    );
    await user.clear(address);
    await user.type(address, "http://studio.local:8080/v1");
    await user.type(within(form).getByLabelText("API key (optional)"), "sk-local");
    await user.click(within(form).getByRole("button", { name: "Add server" }));
    expect(await within(form).findByRole("status")).toHaveTextContent(
      "Added studio.local:8080: 1 model.",
    );

    // Its model shows below, ready to use.
    await user.click(screen.getByRole("button", { name: "Use studio.local:8080 · gpt-oss-120b" }));
    expect(await screen.findByRole("navigation", { name: "Sessions" })).toBeInTheDocument();
  });
});
