import { describe, expect, it } from "vitest";
import { projectFile } from "./__fixtures__/helpers.ts";
import {
  commandPatternMatches,
  compileRule,
  parseRuleText,
  specifierMatches,
  toolNameMatches,
  validatePermissionRules,
} from "./rules.ts";

describe("parseRuleText", () => {
  it.each([
    ["Bash", { toolName: "Bash", specifier: null }],
    ["Bash(*)", { toolName: "Bash", specifier: null }],
    ["Bash(npm run build)", { toolName: "Bash", specifier: "npm run build" }],
    ["Read(./.env)", { toolName: "Read", specifier: "./.env" }],
    ["WebFetch(domain:example.com)", { toolName: "WebFetch", specifier: "domain:example.com" }],
    // Parentheses inside the content are literal, as documented.
    ["Edit(./Finance (2024)/**)", { toolName: "Edit", specifier: "./Finance (2024)/**" }],
    ["Bash(echo ())", { toolName: "Bash", specifier: "echo ()" }],
    [
      "mcp__puppeteer__puppeteer_navigate",
      { toolName: "mcp__puppeteer__puppeteer_navigate", specifier: null },
    ],
    [
      "mcp__plugin_my-plugin_database-tools__*",
      { toolName: "mcp__plugin_my-plugin_database-tools__*", specifier: null },
    ],
    ["  Read  ", { toolName: "Read", specifier: null }],
    ["*", { toolName: "*", specifier: null }],
  ])("%s", (text, expected) => {
    expect(parseRuleText(text)).toEqual({ ok: true, rule: expected });
  });

  it.each(["", "Bash(ls) x", "Bash(ls", "Bash ls)", "Bash()", "(ls)", "Ba sh", "Bash (ls)"])(
    "rejects %j without throwing",
    (text) => {
      const r = parseRuleText(text);
      expect(r.ok).toBe(false);
    },
  );

  it("never throws on odd input", () => {
    // biome-ignore lint/suspicious/noExplicitAny: the point is input the types do not allow
    expect(parseRuleText(undefined as any).ok).toBe(false);
    expect(parseRuleText("((((").ok).toBe(false);
  });
});

describe("rule problems", () => {
  const problems = (list: "allow" | "ask" | "deny", rule: string) =>
    validatePermissionRules({
      allow: list === "allow" ? [{ rule, from: projectFile }] : [],
      ask: list === "ask" ? [{ rule, from: projectFile }] : [],
      deny: list === "deny" ? [{ rule, from: projectFile }] : [],
    });

  it("reports a malformed rule and skips it", () => {
    const p = problems("deny", "Bash(ls) x");
    expect(p).toHaveLength(1);
    expect(p[0]?.severity).toBe("error");
    expect(compileRule({ rule: "Bash(ls) x", from: projectFile }, "deny").rule).toBeNull();
  });

  it("skips mcp__ rules with parentheses, as documented", () => {
    expect(problems("deny", "mcp__github__get_issue(x)")[0]?.severity).toBe("error");
  });

  it("skips unanchored tool-name globs in allow rules", () => {
    for (const rule of ["*", "B*", "mcp__*"]) {
      expect(problems("allow", rule)[0]?.severity, rule).toBe("error");
    }
    expect(problems("allow", "mcp__puppeteer__*")).toEqual([]);
    expect(problems("deny", "mcp__*")).toEqual([]);
  });

  it("warns that Write/Glob/Grep path rules are applied as Edit/Read, and skips them as allow", () => {
    expect(problems("deny", "Write(docs/**)")[0]?.severity).toBe("warning");
    expect(problems("allow", "Write(docs/**)")[0]?.severity).toBe("error");
    expect(problems("deny", "Grep(docs/**)")[0]?.message).toMatch(/Read/);
  });

  it("skips rules on input fields, which cannot be matched here", () => {
    expect(problems("deny", "Bash(command:rm *)")[0]?.severity).toBe("error");
    expect(problems("deny", "Bash(run_in_background:true)")[0]?.severity).toBe("error");
    // `ls:*` is the legacy prefix form, not a field.
    expect(problems("allow", "Bash(ls:*)")).toEqual([]);
  });

  it("warns about an allow rule with a wildcard before the rest of the command", () => {
    expect(problems("allow", "Bash(git * main)")[0]?.severity).toBe("warning");
    expect(problems("allow", "Bash(git log *)")).toEqual([]);
  });

  it("reports deny rules naming no known tool", () => {
    const p = validatePermissionRules(
      { allow: [], ask: [], deny: [{ rule: "Bsh", from: projectFile }] },
      ["Bash", "Read"],
    );
    expect(p[0]?.message).toMatch(/matches no known tool/);
  });

  it("rejects a ! pattern in an allow rule", () => {
    expect(problems("allow", "Read(!x)")[0]?.severity).toBe("error");
  });
});

describe("command patterns (documented examples)", () => {
  const rows: [string, string[], string[]][] = [
    ["npm run build", ["npm run build"], ["npm run build --watch"]],
    ["npm run *", ["npm run build", "npm run test --watch", "npm run"], ["npm install"]],
    [
      "git log * main",
      ["git log --oneline main", "git log -5 main", "git log --output=<file> main"],
      ["git log main", "git push origin main"],
    ],
    [
      "git * main",
      ["git merge main", "git push origin main", "git -c core.fsmonitor=<script> diff main"],
      ["git log"],
    ],
    ["* --version", ["node --version", "bash -c 'echo hi' --version"], ["node -v"]],
    ["ls *", ["ls -la", "ls"], ["lsof"]],
    ["ls*", ["ls -la", "lsof"], []],
    ["* --help *", ["npm --help x"], ["npm --help"]],
    ["ls:*", ["ls -la", "ls"], ["lsof"]],
    ["git:* push", [], ["git push", "git status push"]],
    ["git:* push", ["git:x push"], []],
  ];
  it.each(rows)("Bash(%s)", (pattern, matches, misses) => {
    for (const c of matches) expect(commandPatternMatches(pattern, c, false), c).toBe(true);
    for (const c of misses) expect(commandPatternMatches(pattern, c, false), c).toBe(false);
  });

  it("matches multi-line arguments with *", () => {
    expect(commandPatternMatches("git commit *", "git commit -m 'a\nb'", false)).toBe(true);
  });

  it("matches without regard to case only when asked to", () => {
    expect(commandPatternMatches("git push *", "GIT PUSH x", true)).toBe(true);
    expect(commandPatternMatches("git push *", "GIT PUSH x", false)).toBe(false);
  });

  it("treats regular-expression characters literally", () => {
    expect(commandPatternMatches("echo a.b", "echo axb", false)).toBe(false);
    expect(commandPatternMatches("echo (a|b)", "echo (a|b)", false)).toBe(true);
  });
});

describe("tool names", () => {
  const rule = (text: string, list: "allow" | "ask" | "deny") => {
    const r = compileRule({ rule: text, from: projectFile }, list).rule;
    if (r === null) throw new Error(`did not compile: ${text}`);
    return r;
  };

  it("matches MCP servers and tools as documented", () => {
    expect(toolNameMatches(rule("mcp__puppeteer", "allow"), "mcp__puppeteer__navigate")).toBe(true);
    expect(toolNameMatches(rule("mcp__puppeteer__*", "allow"), "mcp__puppeteer__navigate")).toBe(
      true,
    );
    expect(toolNameMatches(rule("mcp__github__get_*", "allow"), "mcp__github__get_issue")).toBe(
      true,
    );
    expect(toolNameMatches(rule("mcp__github__get_*", "allow"), "mcp__github__create_issue")).toBe(
      false,
    );
    expect(toolNameMatches(rule("mcp__puppeteer", "allow"), "mcp__puppeteerx__navigate")).toBe(
      false,
    );
  });

  it("reads a server whose name contains __ differently for allow and for deny", () => {
    // As allow, `mcp__reports` cannot cover `reports__v2`'s tools; as deny it does.
    expect(toolNameMatches(rule("mcp__reports", "allow"), "mcp__reports__v2__run")).toBe(false);
    expect(toolNameMatches(rule("mcp__reports", "deny"), "mcp__reports__v2__run")).toBe(true);
    expect(toolNameMatches(rule("mcp__reports__v2", "deny"), "mcp__reports__v2__run")).toBe(true);
    expect(toolNameMatches(rule("mcp__reports__v2__*", "allow"), "mcp__reports__v2__run")).toBe(
      true,
    );
  });

  it("matches tool-name globs for deny", () => {
    expect(toolNameMatches(rule("*", "deny"), "Anything")).toBe(true);
    expect(toolNameMatches(rule("mcp__*", "deny"), "mcp__a__b")).toBe(true);
    expect(toolNameMatches(rule("mcp__*", "deny"), "Bash")).toBe(false);
  });
});

describe("other specifiers", () => {
  it("follows the documented WebFetch domain examples for allow", () => {
    const allow = (p: string, v: string) => specifierMatches(p, v, "allow");
    expect(allow("domain:example.com", "domain:example.com")).toBe(true);
    expect(allow("domain:example.com", "domain:api.example.com")).toBe(false);
    expect(allow("domain:*.example.com", "domain:api.example.com")).toBe(true);
    expect(allow("domain:*.example.com", "domain:a.b.example.com")).toBe(true);
    expect(allow("domain:*.example.com", "domain:example.com")).toBe(false);
    expect(allow("domain:*", "domain:anything.org")).toBe(true);
    expect(allow("domain:example.*", "domain:example.org")).toBe(true);
    expect(allow("domain:example.*", "domain:example.evil.com")).toBe(false);
  });

  it("lets * reach further for deny and ask, which only narrows what runs", () => {
    expect(specifierMatches("domain:example.*", "domain:example.evil.com", "deny")).toBe(true);
    expect(specifierMatches("model:OPUS", "model:opus", "deny")).toBe(true);
    expect(specifierMatches("model:OPUS", "model:opus", "allow")).toBe(false);
  });
});
