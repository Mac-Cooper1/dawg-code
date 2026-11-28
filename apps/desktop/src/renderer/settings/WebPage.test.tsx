import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedTheme } from "../../shared/bridge.ts";
import { createFakeWeb, type FakeWebOptions } from "../bridge/fake-web.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { WebPage } from "./WebPage.tsx";

function setup(theme: ResolvedTheme, options: FakeWebOptions = {}) {
  const fake = createFakeWeb(options);
  const onOpenLink = vi.fn();
  renderInTheme(<WebPage api={fake.api} onOpenLink={onOpenLink} />, theme);
  return { fake, onOpenLink, user: userEvent.setup() };
}

const option = (name: string) => screen.getByRole("radio", { name: new RegExp(`^${name}`) });
const statusLine = () => screen.getByText(/^Web search (is off|uses)/);

describe.each(THEMES)("Settings → Web (%s)", (theme) => {
  it("says what each tool does, and starts with web search off", async () => {
    setup(theme);
    expect(screen.getByRole("heading", { level: 1, name: "Web" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Fetching pages" })).toBeInTheDocument();
    expect(screen.getByText(/WebFetch reads a public web page/)).toBeInTheDocument();
    expect(screen.getByText(/WebSearch gives the model the titles, links/)).toBeInTheDocument();
    await waitFor(() => expect(statusLine()).toHaveTextContent("Web search is off."));
    expect(option("Off")).toBeChecked();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    // Brave Search is the service dawg suggests; the others are not marked.
    expect(option("Brave Search")).toHaveAccessibleName(/Suggested/);
    expect(option("Tavily")).not.toHaveAccessibleName(/Suggested/);
  });

  it("stores a key, masked, and never shows it again", async () => {
    const { fake, user } = setup(theme);
    await user.click(await screen.findByRole("radio", { name: /^Brave Search/ }));
    const key = screen.getByLabelText("Brave Search API key");
    expect(key).toHaveAttribute("type", "password");
    expect(key).toHaveAttribute("autocomplete", "off");
    await user.type(key, "BSA-secret");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(statusLine()).toHaveTextContent("Web search uses Brave Search."));
    expect(screen.getByText("Saved. New sessions search with Brave Search.")).toBeInTheDocument();
    expect(fake.stored).toMatchObject({ provider: "brave", keys: { brave: "BSA-secret" } });
    expect(screen.getByLabelText("Brave Search API key")).toHaveValue("");
    expect(document.body.textContent).not.toContain("BSA-secret");
    expect(screen.getByText("Key in your Keychain")).toBeInTheDocument();
  });

  it("says what is missing before saving", async () => {
    const { fake, user } = setup(theme);
    await user.click(await screen.findByRole("radio", { name: /^Tavily/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your Tavily API key.");
    expect(fake.stored.provider).toBeNull();
  });

  it("checks a key before it is saved, and reports a refused one", async () => {
    const { fake, user } = setup(theme);
    await user.click(await screen.findByRole("radio", { name: /^Brave Search/ }));
    await user.type(screen.getByLabelText("Brave Search API key"), "bad-key");
    await user.click(screen.getByRole("button", { name: "Check it works" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Brave Search refused the key (401).",
    );
    expect(fake.checks).toEqual([{ provider: "brave", apiKey: "bad-key" }]);
    await user.clear(screen.getByLabelText("Brave Search API key"));
    await user.type(screen.getByLabelText("Brave Search API key"), "good-key");
    await user.click(screen.getByRole("button", { name: "Check it works" }));
    expect(await screen.findByText("Brave Search answered with 5 results.")).toBeInTheDocument();
    expect(fake.stored.keys.brave).toBeUndefined();
  });

  it("takes a SearXNG address instead of a key", async () => {
    const { fake, user } = setup(theme);
    await user.click(await screen.findByRole("radio", { name: /^SearXNG/ }));
    expect(screen.queryByLabelText(/API key/)).toBeNull();
    const address = screen.getByLabelText("Instance address");
    await user.type(address, "not a url");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/http or https address/);
    await user.clear(address);
    await user.type(address, "http://localhost:8888");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(statusLine()).toHaveTextContent("Web search uses SearXNG."));
    expect(fake.stored).toMatchObject({ provider: "searxng", searxngUrl: "http://localhost:8888" });
  });

  it("removes a stored key, which turns web search off when it was in use", async () => {
    const { fake, user } = setup(theme, { provider: "tavily", keys: { tavily: "tvly-1" } });
    await waitFor(() => expect(statusLine()).toHaveTextContent("Web search uses Tavily."));
    await user.click(screen.getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(statusLine()).toHaveTextContent("Web search is off."));
    expect(screen.getByText("Removed the Tavily key from your Keychain.")).toBeInTheDocument();
    expect(option("Off")).toBeChecked();
    expect(fake.stored.keys.tavily).toBeUndefined();
  });

  it("turns web search off, keeping the key", async () => {
    const { fake, user } = setup(theme, { provider: "brave", keys: { brave: "k" } });
    await user.click(await screen.findByRole("radio", { name: /^Off/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(statusLine()).toHaveTextContent("Web search is off."));
    expect(fake.stored.keys.brave).toBe("k");
  });

  it("is usable from the keyboard", async () => {
    const { user } = setup(theme, { provider: "brave", keys: { brave: "k" } });
    await waitFor(() => expect(option("Brave Search")).toBeChecked());
    await user.click(option("Brave Search"));
    // Held down, as a person would: Radix chooses when focus arrives while an arrow is pressed.
    await user.keyboard("{ArrowDown>}");
    await waitFor(() => expect(option("Tavily")).toBeChecked());
    await user.keyboard("{/ArrowDown}");
    await user.tab();
    expect(screen.getByLabelText("Tavily API key")).toHaveFocus();
  });

  it("opens the provider's site in the browser", async () => {
    const { user, onOpenLink } = setup(theme);
    await user.click(await screen.findByRole("radio", { name: /^Brave Search/ }));
    await user.click(screen.getByRole("button", { name: "Get a Brave Search key" }));
    expect(onOpenLink).toHaveBeenCalledWith("https://brave.com/search/api/");
  });

  it("says when keys cannot be stored on this Mac", async () => {
    setup(theme, { keychainAvailable: false });
    expect(await screen.findByText(/Keychain is not available/)).toBeInTheDocument();
  });
});
