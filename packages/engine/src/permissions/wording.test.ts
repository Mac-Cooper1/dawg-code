import { describe, expect, it } from "vitest";
import type { PermissionDecision, PermissionQuery } from "../contracts/permissions.ts";
import { bash, edit, HOME, localFile, PROJECT, read, run } from "./__fixtures__/helpers.ts";
import { describePermissionRequest, displayPath } from "./wording.ts";

const ctx = { cwd: PROJECT, homeDir: HOME };
const describe_ = (query: PermissionQuery, d: PermissionDecision) =>
  describePermissionRequest(query, d, ctx);
const cmdQuery = (command: string): PermissionQuery => ({
  toolName: "Bash",
  subject: { kind: "command", command },
});

describe("permission request wording", () => {
  it("titles each kind of call", () => {
    expect(describe_(cmdQuery("npm test"), bash("npm test")).title).toBe("Run a shell command");
    const e: PermissionQuery = {
      toolName: "Edit",
      subject: { kind: "edit", paths: [`${PROJECT}/src/a.ts`] },
    };
    expect(describe_(e, edit([`${PROJECT}/src/a.ts`])).title).toBe("Edit src/a.ts");
    const r: PermissionQuery = {
      toolName: "Read",
      subject: { kind: "read", paths: [`${HOME}/x.md`] },
    };
    expect(describe_(r, read([`${HOME}/x.md`])).title).toBe("Read ~/x.md");
    const w: PermissionQuery = {
      toolName: "WebFetch",
      subject: { kind: "other", specifier: null },
    };
    expect(describe_(w, run("WebFetch", { kind: "other", specifier: null })).title).toBe(
      "Use WebFetch",
    );
  });

  it("says why, naming the rule and its file", () => {
    const d = bash("git push origin", { ask: [{ rule: "Bash(git push *)", from: localFile }] });
    expect(describe_(cmdQuery("git push origin"), d).reason).toBe(
      "The ask rule Bash(git push *) in .dawg/settings.local.json requires approval for this command.",
    );
  });

  it("names the part of a compound command that needs approval", () => {
    const d = bash("ls && npm test");
    expect(describe_(cmdQuery("ls && npm test"), d).reason).toBe(
      "`npm test`: no rule allows this command.",
    );
  });

  it("explains protected paths and the working directories", () => {
    const q = (p: string): PermissionQuery => ({
      toolName: "Edit",
      subject: { kind: "edit", paths: [p] },
    });
    expect(describe_(q(`${PROJECT}/.git/config`), edit([`${PROJECT}/.git/config`])).reason).toMatch(
      /^\.git\/config is git data/,
    );
    expect(describe_(q("/tmp/x"), edit(["/tmp/x"])).reason).toBe(
      "/tmp/x is outside the working directories.",
    );
    const rmQ = cmdQuery("rm -rf .");
    expect(describe_(rmQ, bash("rm -rf .", { allow: ["Bash"] })).reason).toBe(
      "It would remove ., which holds the working directory.",
    );
  });

  it("explains commands that cannot be checked", () => {
    const d = bash("f() { :; }");
    expect(describe_(cmdQuery("f() { :; }"), d).reason).toBe(
      "The command could not be checked safely: defines a shell function.",
    );
  });
});

describe("denial messages for the model", () => {
  it("names the deny rule", () => {
    const d = bash("rm -rf build", { deny: ["Bash(rm *)"] });
    expect(d.behavior === "deny" && d.message).toMatch(
      /^Denied: the deny rule Bash\(rm \*\) in .*blocks this command/,
    );
  });

  it("tells the model what to do in plan mode", () => {
    const d = edit([`${PROJECT}/a.ts`], { mode: "plan" });
    expect(d.behavior === "deny" && d.message).toMatch(/ExitPlanMode/);
  });

  it("explains a denial that only happened because nothing can ask", () => {
    const d = bash("npm test", { mode: "dontAsk" });
    expect(d.behavior === "deny" && d.message).toMatch(/does not ask for approval/);
    const q = run("AskUserQuestion", { kind: "none" }, { mode: "dontAsk" });
    expect(q.behavior === "deny" && q.message).toMatch(/No one can answer/);
  });
});

describe("displayPath", () => {
  it("shortens paths under the working directory and home", () => {
    expect(displayPath(`${PROJECT}/a/b`, ctx)).toBe("a/b");
    expect(displayPath(PROJECT, ctx)).toBe(".");
    expect(displayPath(`${HOME}/x`, ctx)).toBe("~/x");
    expect(displayPath("/etc/hosts", ctx)).toBe("/etc/hosts");
  });
});
