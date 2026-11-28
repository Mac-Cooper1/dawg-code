import { describe, expect, it } from "vitest";
import {
  type ElicitationField,
  ElicitationFieldSchema,
  ElicitationRespondParamsSchema,
  elicitationIssues,
} from "./elicitation.ts";
import {
  PendingRequestSchema,
  RequestResolvedEventSchema,
  SessionStatusEventSchema,
} from "./events.ts";
import { ClientCapabilitiesSchema } from "./methods.ts";

const base = { sessionId: "s1", seq: 1, time: 1 };

describe("elicitation schemas", () => {
  it("takes every field type of MCP's restricted schema", () => {
    const common = { title: null, description: null, required: false };
    const fields = [
      {
        ...common,
        name: "a",
        type: "string",
        format: "email",
        minLength: 1,
        maxLength: 9,
        default: null,
      },
      { ...common, name: "b", type: "number", minimum: 0, maximum: 1.5, default: 1 },
      { ...common, name: "c", type: "integer", minimum: null, maximum: 10, default: null },
      { ...common, name: "d", type: "boolean", default: true },
      { ...common, name: "e", type: "select", options: [{ value: "x", title: "X" }], default: "x" },
      {
        ...common,
        name: "f",
        type: "multiselect",
        options: [{ value: "x", title: null }],
        minItems: 0,
        maxItems: 1,
        default: [],
      },
    ];
    for (const field of fields) expect(ElicitationFieldSchema.parse(field)).toEqual(field);
    expect(() =>
      ElicitationFieldSchema.parse({ ...common, name: "g", type: "string", format: "phone" }),
    ).toThrow();
    expect(() =>
      ElicitationFieldSchema.parse({
        ...common,
        name: "h",
        type: "select",
        options: [],
        default: null,
      }),
    ).toThrow();
  });

  it("is a pending request kind, a status and a resolution", () => {
    const pending = PendingRequestSchema.parse({
      kind: "elicitation",
      turnId: "t1",
      requestId: "e1",
      toolCallId: null,
      server: "tracker",
      message: "Open the page to sign in.",
      mode: "url",
      fields: [],
      url: "https://example.com/connect",
    });
    expect(pending.kind).toBe("elicitation");
    const status = SessionStatusEventSchema.parse({
      ...base,
      status: "waiting",
      waitingOn: "elicitation",
      message: "Waiting for your input",
    });
    expect(status.waitingOn).toBe("elicitation");
    const resolved = RequestResolvedEventSchema.parse({
      ...base,
      kind: "elicitation",
      turnId: "t1",
      requestId: "e1",
      outcome: "answered",
      response: { action: "decline" },
    });
    expect(resolved).toMatchObject({ response: { action: "decline", content: null } });
  });

  it("answers with an action, and content only when given", () => {
    expect(
      ElicitationRespondParamsSchema.parse({ sessionId: "s1", requestId: "e1", action: "cancel" }),
    ).toEqual({ sessionId: "s1", requestId: "e1", action: "cancel" });
    expect(() =>
      ElicitationRespondParamsSchema.parse({
        sessionId: "s1",
        requestId: "e1",
        action: "accept",
        content: { nested: { no: true } },
      }),
    ).toThrow();
  });

  it("is a capability clients have unless they say otherwise", () => {
    expect(ClientCapabilitiesSchema.parse({}).elicitation).toBe(true);
    expect(ClientCapabilitiesSchema.parse({ elicitation: false }).elicitation).toBe(false);
  });
});

describe("checking an answer against the form", () => {
  const common = { title: null, description: null, default: null };
  const fields: ElicitationField[] = [
    {
      ...common,
      name: "email",
      type: "string",
      required: true,
      format: "email",
      minLength: null,
      maxLength: null,
    },
    {
      ...common,
      name: "code",
      type: "string",
      required: false,
      format: null,
      minLength: 2,
      maxLength: 3,
    },
    {
      ...common,
      name: "due",
      type: "string",
      required: false,
      format: "date",
      minLength: null,
      maxLength: null,
    },
    {
      ...common,
      name: "at",
      type: "string",
      required: false,
      format: "date-time",
      minLength: null,
      maxLength: null,
    },
    {
      ...common,
      name: "site",
      type: "string",
      required: false,
      format: "uri",
      minLength: null,
      maxLength: null,
    },
    { ...common, name: "count", type: "integer", required: false, minimum: 1, maximum: 5 },
    { ...common, name: "ratio", type: "number", required: false, minimum: 0, maximum: null },
    { ...common, name: "ok", type: "boolean", required: false },
    {
      ...common,
      name: "colour",
      type: "select",
      required: false,
      options: [{ value: "red", title: "Red" }],
    },
    {
      ...common,
      name: "tags",
      type: "multiselect",
      required: false,
      options: [
        { value: "a", title: null },
        { value: "b", title: null },
      ],
      minItems: 1,
      maxItems: 1,
    },
  ];
  const issue = (content: Record<string, unknown>) =>
    elicitationIssues(fields, { email: "me@example.com", ...content }).map((i) => i.message);

  it("passes a valid answer", () => {
    expect(
      issue({
        code: "ab",
        due: "2026-02-28",
        at: "2026-11-27T09:30:00Z",
        site: "https://example.com",
        count: 3,
        ratio: 0.5,
        ok: false,
        colour: "red",
        tags: ["b"],
      }),
    ).toEqual([]);
  });

  it("names each problem in plain words", () => {
    expect(elicitationIssues(fields, {})).toEqual([
      { field: "email", message: "This is required." },
    ]);
    expect(issue({ email: "nope" })).toEqual(["Enter an email address."]);
    expect(issue({ code: "a" })).toEqual(["Use at least 2 characters."]);
    expect(issue({ code: "abcd" })).toEqual(["Use at most 3 characters."]);
    expect(issue({ due: "2026-02-30" })).toEqual(["Enter a date as YYYY-MM-DD."]);
    expect(issue({ at: "tomorrow" })).toEqual([
      "Enter a date and time, such as 2026-11-27T09:30:00Z.",
    ]);
    expect(issue({ site: "example" })).toEqual([
      "Enter a full address, such as https://example.com.",
    ]);
    expect(issue({ count: 2.5 })).toEqual(["Enter a whole number."]);
    expect(issue({ count: 9 })).toEqual(["Enter a number from 1 to 5."]);
    expect(issue({ ratio: -1 })).toEqual(["Enter 0 or more."]);
    expect(issue({ ok: "yes" })).toEqual(["Choose yes or no."]);
    expect(issue({ colour: "blue" })).toEqual(["Pick one of the choices."]);
    expect(issue({ tags: [] })).toEqual(["Pick at least 1."]);
    expect(issue({ tags: ["a", "b"] })).toEqual(["Pick at most 1."]);
    expect(issue({ tags: ["c"] })).toEqual(["Pick only from the choices."]);
    expect(issue({ extra: 1 })).toEqual(["The form has no field named extra."]);
  });
});
