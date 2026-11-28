/**
 * WebFetch and WebSearch through the permission engine, with the subjects the tools report:
 * the documented domain rules (code.claude.com/docs/en/permissions, "WebFetch"), and asking by
 * default, with the URL's host in the card.
 */
import { describe, expect, it } from "vitest";
import type { PermissionQuery } from "../../contracts/permissions.ts";
import { run, type StateInput } from "../../permissions/__fixtures__/helpers.ts";
import { describePermissionRequest } from "../../permissions/wording.ts";
import { webSearchTool } from "../web-search/web-search.ts";
import { createWebFetchTool } from "./web-fetch.ts";

const tool = createWebFetchTool();
const probe = {
  cwd: "/p",
  workingDirectories: ["/p"],
  state: { get: <T>(_k: string, c: () => T) => c() },
};

function fetchDecision(url: string, rules: StateInput = {}) {
  const subject = tool.permission({ url, prompt: "x" }, probe);
  return { subject, decision: run("WebFetch", subject, rules) };
}

describe("WebFetch permissions", () => {
  it("asks by default, offering to allow the domain", () => {
    const { decision, subject } = fetchDecision("https://docs.example.com/guide");
    expect(decision.behavior).toBe("ask");
    if (decision.behavior === "ask")
      expect(decision.suggestions).toEqual(["WebFetch(domain:docs.example.com)"]);
    const query: PermissionQuery = { toolName: "WebFetch", subject };
    const words = describePermissionRequest(query, decision);
    expect(words.title).toBe("Fetch a page from docs.example.com");
    expect(words.reason).toBe("No rule allows fetching from docs.example.com.");
  });

  it("allows a domain an allow rule names, and only that domain", () => {
    const rules = { allow: ["WebFetch(domain:example.com)"] };
    expect(fetchDecision("https://example.com/a", rules).decision.behavior).toBe("allow");
    expect(fetchDecision("http://example.com/a", rules).decision.behavior).toBe("allow");
    expect(fetchDecision("https://api.example.com/a", rules).decision.behavior).toBe("ask");
    expect(fetchDecision("https://example.com.evil.org/a", rules).decision.behavior).toBe("ask");
  });

  it("matches case-insensitively and ignores a trailing dot, as documented", () => {
    for (const rule of ["WebFetch(domain:EXAMPLE.com)", "WebFetch(domain:example.com.)"]) {
      expect(
        fetchDecision("https://Example.COM./a", { allow: [rule] }).decision.behavior,
        rule,
      ).toBe("allow");
    }
  });

  it("covers subdomains at any depth with *., but not the domain itself", () => {
    const rules = { allow: ["WebFetch(domain:*.example.com)"] };
    expect(fetchDecision("https://a.b.example.com/", rules).decision.behavior).toBe("allow");
    expect(fetchDecision("https://example.com/", rules).decision.behavior).toBe("ask");
  });

  it("lets deny and ask rules win over allow", () => {
    expect(
      fetchDecision("https://example.com/", {
        allow: ["WebFetch"],
        deny: ["WebFetch(domain:example.com)"],
      }).decision.behavior,
    ).toBe("deny");
    expect(
      fetchDecision("https://example.com/", {
        allow: ["WebFetch(domain:*)"],
        ask: ["WebFetch(domain:example.com)"],
      }).decision.behavior,
    ).toBe("ask");
    expect(
      fetchDecision("https://anything.org/", { allow: ["WebFetch(domain:*)"] }).decision.behavior,
    ).toBe("allow");
  });

  it("a bare WebFetch deny rule refuses even URLs that would be refused anyway", () => {
    expect(fetchDecision("http://localhost/", { deny: ["WebFetch"] }).decision.behavior).toBe(
      "deny",
    );
    expect(fetchDecision("http://localhost/").decision.behavior).toBe("allow");
  });

  it("in dontAsk mode a fetch nothing allows is denied", () => {
    expect(fetchDecision("https://example.com/", { mode: "dontAsk" }).decision.behavior).toBe(
      "deny",
    );
  });
});

describe("WebSearch permissions", () => {
  const subject = webSearchTool.permission({ query: "x" }, probe);

  it("asks by default and offers the bare rule, which takes no specifier", () => {
    const decision = run("WebSearch", subject);
    expect(decision.behavior).toBe("ask");
    if (decision.behavior === "ask") expect(decision.suggestions).toEqual(["WebSearch"]);
    expect(describePermissionRequest({ toolName: "WebSearch", subject }, decision).title).toBe(
      "Search the web",
    );
  });

  it("follows a bare allow or deny rule", () => {
    expect(run("WebSearch", subject, { allow: ["WebSearch"] }).behavior).toBe("allow");
    expect(run("WebSearch", subject, { allow: ["WebSearch"], deny: ["WebSearch"] }).behavior).toBe(
      "deny",
    );
  });
});
