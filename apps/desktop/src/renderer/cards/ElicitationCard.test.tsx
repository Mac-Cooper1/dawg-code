import type { ElicitationField } from "@dawg/protocol";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ElicitationItem } from "../state/types.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { makeEnv } from "../transcript/testing.ts";
import { ElicitationCard, hostOf } from "./ElicitationCard.tsx";
import { elicitationRecord } from "./records.ts";

const none = { title: null, description: null } as const;

/** One field of every kind MCP allows. */
const FIELDS: ElicitationField[] = [
  {
    ...none,
    name: "name",
    title: "Name",
    description: "Who the table is for",
    type: "string",
    required: true,
    format: null,
    minLength: 2,
    maxLength: 40,
    default: null,
  },
  {
    ...none,
    name: "email",
    title: "Email",
    type: "string",
    required: true,
    format: "email",
    minLength: null,
    maxLength: null,
    default: null,
  },
  {
    ...none,
    name: "day",
    title: "Day",
    type: "string",
    required: false,
    format: "date",
    minLength: null,
    maxLength: null,
    default: null,
  },
  {
    ...none,
    name: "at",
    title: "Arrival",
    type: "string",
    required: false,
    format: "date-time",
    minLength: null,
    maxLength: null,
    default: null,
  },
  {
    ...none,
    name: "guests",
    title: "Guests",
    type: "integer",
    required: true,
    minimum: 1,
    maximum: 10,
    default: 2,
  },
  {
    ...none,
    name: "budget",
    type: "number",
    required: false,
    minimum: 0,
    maximum: null,
    default: null,
  },
  {
    ...none,
    name: "outside",
    title: "Sit outside",
    type: "boolean",
    required: false,
    default: false,
  },
  {
    ...none,
    name: "room",
    title: "Room",
    type: "select",
    required: false,
    options: [
      { value: "main", title: "Main room" },
      { value: "garden", title: "Garden" },
    ],
    default: "main",
  },
  {
    ...none,
    name: "extras",
    title: "Extras",
    type: "multiselect",
    required: false,
    options: [
      { value: "cake", title: "Birthday cake" },
      { value: "flowers", title: null },
    ],
    minItems: null,
    maxItems: 1,
    default: ["cake"],
  },
];

function formItem(overrides: Partial<ElicitationItem> = {}): ElicitationItem {
  return {
    id: "elicitation:e1",
    turnId: "turn-1",
    seq: 7,
    kind: "elicitation",
    requestId: "e1",
    toolCallId: "call-1",
    server: "forms",
    message: "Book a table. See https://evil.example.com and **bold**.",
    mode: "form",
    fields: FIELDS,
    url: null,
    state: "pending",
    response: null,
    ...overrides,
  };
}

function pageItem(overrides: Partial<ElicitationItem> = {}): ElicitationItem {
  return formItem({
    message: "Sign in to go on.",
    mode: "url",
    fields: [],
    url: "https://example.com/connect?session=test",
    ...overrides,
  });
}

describe.each(THEMES)("ElicitationCard (%s)", (theme) => {
  it("draws a control per field, with defaults, and the server's words as plain text", () => {
    renderInTheme(
      <ElicitationCard item={formItem()} shownAgain={false} autoFocus={false} env={makeEnv()} />,
      theme,
    );
    const card = screen.getByRole("region", { name: "forms asks for input" });
    // Plain text: no link, no Markdown.
    expect(
      within(card).getByText("Book a table. See https://evil.example.com and **bold**."),
    ).toBeInTheDocument();
    expect(within(card).queryByRole("link")).toBeNull();
    expect(card.querySelector("strong")).toBeNull();

    const name = within(card).getByLabelText("Name");
    expect(name).toHaveAttribute("type", "text");
    expect(name).toHaveAttribute("aria-required", "true");
    expect(name).toHaveAccessibleDescription("Who the table is for");
    expect(within(card).getByLabelText("Email")).toHaveAttribute("type", "email");
    expect(within(card).getByLabelText("Day")).toHaveAttribute("type", "date");
    expect(within(card).getByLabelText("Arrival")).toHaveAttribute(
      "placeholder",
      "2026-11-27T09:30:00Z",
    );
    const guests = within(card).getByLabelText("Guests");
    expect(guests).toHaveAttribute("type", "number");
    expect(guests).toHaveValue(2);
    expect(guests).toHaveAttribute("min", "1");
    expect(guests).toHaveAttribute("max", "10");
    // Untitled fields are labelled by their name.
    expect(within(card).getByLabelText("budget")).toHaveAttribute("step", "any");
    expect(within(card).getByRole("checkbox", { name: "Sit outside" })).not.toBeChecked();
    const room = within(card).getByRole("radiogroup", { name: "Room" });
    expect(within(room).getByRole("radio", { name: "Main room" })).toBeChecked();
    const extras = within(card).getByRole("group", { name: /Extras/ });
    expect(within(extras).getByRole("checkbox", { name: "Birthday cake" })).toBeChecked();
    expect(within(extras).getByRole("checkbox", { name: "flowers" })).not.toBeChecked();
    for (const label of ["Submit", "Decline", "Cancel"]) {
      expect(within(card).getByRole("button", { name: new RegExp(`^${label}`) })).toBeEnabled();
    }
  });

  it("checks a field when it is left, and every field on Submit, then sends only what was filled in", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    renderInTheme(
      <ElicitationCard item={formItem()} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    const card = screen.getByRole("region", { name: "forms asks for input" });
    const email = within(card).getByLabelText("Email");
    await user.type(email, "nope");
    await user.tab();
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAccessibleDescription("Enter an email address.");

    await user.click(within(card).getByRole("button", { name: /^Submit/ }));
    expect(env.respondElicitation).not.toHaveBeenCalled();
    // The first field that needs a change takes focus, with its message.
    const name = within(card).getByLabelText("Name");
    expect(name).toHaveFocus();
    expect(name).toHaveAccessibleDescription("Who the table is for This is required.");

    await user.type(name, "Ada");
    await user.clear(email);
    await user.type(email, "ada@example.com");
    expect(email).not.toHaveAttribute("aria-invalid");
    await user.click(within(card).getByRole("checkbox", { name: "Sit outside" }));
    await user.click(within(card).getByRole("radio", { name: "Garden" }));
    await user.click(within(card).getByRole("button", { name: /^Submit/ }));
    expect(env.respondElicitation).toHaveBeenCalledWith("e1", {
      action: "accept",
      content: {
        name: "Ada",
        email: "ada@example.com",
        guests: 2,
        outside: true,
        room: "garden",
        extras: ["cake"],
      },
    });
  });

  it("keeps a number within its limits and a choice list within its count", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    renderInTheme(
      <ElicitationCard item={formItem()} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    const card = screen.getByRole("region", { name: "forms asks for input" });
    const guests = within(card).getByLabelText("Guests");
    await user.clear(guests);
    await user.type(guests, "12");
    await user.tab();
    expect(guests).toHaveAccessibleDescription("Enter a number from 1 to 10.");
    await user.click(within(card).getByRole("checkbox", { name: "flowers" }));
    await user.click(within(card).getByRole("button", { name: /^Submit/ }));
    expect(within(card).getByText("Pick at most 1.")).toBeInTheDocument();
    expect(env.respondElicitation).not.toHaveBeenCalled();
  });

  it("declines and cancels, and Escape in a text field only leaves it", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    const { unmount } = renderInTheme(
      <ElicitationCard item={formItem()} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    await user.click(screen.getByRole("button", { name: /^Decline/ }));
    expect(env.respondElicitation).toHaveBeenCalledWith("e1", { action: "decline" });
    unmount();

    const env2 = makeEnv();
    renderInTheme(
      <ElicitationCard item={formItem()} shownAgain={false} autoFocus={false} env={env2} />,
      theme,
    );
    const card = screen.getByRole("region", { name: "forms asks for input" });
    const name = within(card).getByLabelText("Name");
    name.focus();
    fireEvent.keyDown(name, { key: "Escape" });
    expect(within(card).getByRole("button", { name: /^Cancel/ })).toHaveFocus();
    expect(env2.respondElicitation).not.toHaveBeenCalled();
    fireEvent.keyDown(within(card).getByRole("button", { name: /^Cancel/ }), { key: "Escape" });
    expect(env2.respondElicitation).toHaveBeenCalledWith("e1", { action: "cancel" });
  });

  it("submits with ⌘⏎ from a field", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    const item = formItem({ fields: [FIELDS[0] as ElicitationField] });
    renderInTheme(<ElicitationCard item={item} shownAgain={false} autoFocus env={env} />, theme);
    const name = screen.getByLabelText("Name");
    expect(name).toHaveFocus();
    await user.type(name, "Bo");
    fireEvent.keyDown(name, { key: "Enter", metaKey: true });
    expect(env.respondElicitation).toHaveBeenCalledWith("e1", {
      action: "accept",
      content: { name: "Bo" },
    });
  });

  it("shows a page's site and whole address, and opens it only when asked", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    renderInTheme(
      <ElicitationCard item={pageItem()} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    const card = screen.getByRole("region", { name: "forms asks you to open a page" });
    expect(within(card).getByText("example.com")).toBeInTheDocument();
    expect(within(card).getByText("https://example.com/connect?session=test")).toBeInTheDocument();
    expect(within(card).queryByRole("link")).toBeNull();
    expect(within(card).queryByText(/another alphabet/)).toBeNull();
    expect(env.openLink).not.toHaveBeenCalled();
    await user.click(within(card).getByRole("button", { name: /^Open page/ }));
    expect(env.openLink).toHaveBeenCalledWith("https://example.com/connect?session=test");
    expect(env.respondElicitation).toHaveBeenCalledWith("e1", { action: "accept" });
  });

  it("warns about an address with letters from another alphabet", () => {
    const env = makeEnv();
    renderInTheme(
      <ElicitationCard
        item={pageItem({ url: "https://xn--pple-43d.com/login" })}
        shownAgain={false}
        autoFocus={false}
        env={env}
      />,
      theme,
    );
    expect(screen.getByText("xn--pple-43d.com")).toBeInTheDocument();
    expect(screen.getByText(/uses letters from another alphabet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Decline/ }));
    expect(env.respondElicitation).toHaveBeenCalledWith("e1", { action: "decline" });
    expect(env.openLink).not.toHaveBeenCalled();
  });

  it("names the subagent whose call asks, on the card and in its record", () => {
    const env = makeEnv();
    const agent = {
      agentId: "agent-1",
      sessionId: "s-agent",
      agentType: "booker",
      description: "Book a table",
    };
    const { rerender } = renderInTheme(
      <ElicitationCard item={pageItem({ agent })} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    const card = screen.getByRole("region", {
      name: "forms asks you to open a page for the booker agent: Book a table",
    });
    expect(within(card).getByText("booker agent: Book a table")).toBeInTheDocument();
    rerender(
      <ElicitationCard
        item={pageItem({
          agent,
          state: "answered",
          response: { action: "decline", content: null },
        })}
        shownAgain={false}
        autoFocus={false}
        env={env}
      />,
    );
    expect(
      screen.getByText("You declined forms’s request · booker agent: Book a table"),
    ).toBeInTheDocument();
  });

  it("leaves a one-line record once answered, and shows the answer again on request", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    const answered = formItem({
      state: "answered",
      response: { action: "accept", content: { name: "Ada", email: "ada@example.com", guests: 3 } },
    });
    const { rerender } = renderInTheme(
      <ElicitationCard item={answered} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    expect(screen.getByText("You sent forms the form")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show the card again" }));
    expect(env.showCardAgain).toHaveBeenCalledWith("e1", true);
    rerender(<ElicitationCard item={answered} shownAgain autoFocus={false} env={env} />);
    const card = screen.getByRole("region", { name: "forms asked for input" });
    expect(within(card).getByLabelText("Name")).toHaveValue("Ada");
    expect(within(card).getByLabelText("Guests")).toHaveValue(3);
    expect(within(card).queryByRole("button", { name: /^Submit/ })).toBeNull();
  });
});

describe("the record and the host", () => {
  it("says what became of the request", () => {
    expect(elicitationRecord(formItem({ state: "cancelled" }))).toBe(
      "No answer needed: the request ended",
    );
    expect(
      elicitationRecord(
        formItem({ state: "answered", response: { action: "decline", content: null } }),
      ),
    ).toBe("You declined forms’s request");
    expect(
      elicitationRecord(
        formItem({ state: "answered", response: { action: "cancel", content: null } }),
      ),
    ).toBe("Cancelled");
    expect(
      elicitationRecord(
        pageItem({ state: "answered", response: { action: "accept", content: null } }),
      ),
    ).toBe("You opened the page forms asked for");
  });

  it("names the host of an address, or the address when it does not parse", () => {
    expect(hostOf("https://a.example.com:8443/x?y")).toBe("a.example.com:8443");
    expect(hostOf("not a url")).toBe("not a url");
  });
});
