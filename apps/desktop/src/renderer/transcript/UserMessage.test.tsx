import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { CWD, makeEnv, userItem } from "./testing.ts";
import { UserMessage } from "./UserMessage.tsx";

describe.each(THEMES)("UserMessage with what the composer attaches (%s)", (theme) => {
  it("shows mentions as they were sent, folders with a folder icon", () => {
    renderInTheme(
      <UserMessage
        item={userItem({
          text: "Compare @src/tally/money.py#L10-20 with @tests/ and @README.md#L3",
          mentions: [
            { path: "src/tally/money.py", startLine: 10, endLine: 20 },
            { path: "tests/" },
            { path: "README.md", startLine: 3, endLine: 3 },
            { path: `${CWD}/README.md`, startLine: 3, endLine: 3 },
          ],
        })}
        env={makeEnv()}
      />,
      theme,
    );
    const list = screen.getByRole("list", { name: "Mentioned files" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["src/tally/money.py:10–20", "tests/", "README.md:3", "README.md:3"]);
    // A folder's chip draws another icon than a file's.
    const [file, folder, other] = within(list).getAllByRole("listitem");
    const icon = (item: HTMLElement | undefined) => item?.querySelector("svg")?.innerHTML;
    expect(icon(folder)).not.toBe(icon(file));
    expect(icon(other)).toBe(icon(file));
  });

  it("shows images sent without text, and no empty line for the text", () => {
    const { container } = renderInTheme(
      <UserMessage
        item={userItem({
          text: "",
          images: [
            { mediaType: "image/png", data: "iVBORw0KGgo=" },
            { mediaType: "image/jpeg", data: "/9j/4AAQ" },
          ],
        })}
        env={makeEnv()}
      />,
      theme,
    );
    expect(screen.getAllByRole("img").map((image) => image.getAttribute("src"))).toEqual([
      "data:image/png;base64,iVBORw0KGgo=",
      "data:image/jpeg;base64,/9j/4AAQ",
    ]);
    expect(container.querySelector("p")).toBeNull();
  });
});
