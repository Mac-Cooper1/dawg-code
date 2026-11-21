/**
 * Every row of the mode table, for reads, edits, commands and other tools, inside and outside the
 * working directories; and the precedence of deny, ask and allow rules across sources.
 */
import type { PermissionMode } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import type { PermissionDecision, PermissionSubject } from "../contracts/permissions.ts";
import {
  bash,
  decidingRule,
  edit,
  emptyFs,
  flags,
  HOME,
  localFile,
  makeState,
  PROJECT,
  projectFile,
  type RuleInput,
  read,
  reasonType,
  run,
  type StateInput,
  userFile,
} from "./__fixtures__/helpers.ts";
import { decidePermission } from "./decide.ts";

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];
type Expect = [
  default_: string,
  acceptEdits: string,
  plan: string,
  dontAsk: string,
  bypass: string,
];

interface Row {
  name: string;
  tool: string;
  subject: PermissionSubject;
  rules?: Omit<StateInput, "mode">;
  expect: Expect;
}

const P = PROJECT;
const cmd = (command: string): PermissionSubject => ({ kind: "command", command });

const ROWS: Row[] = [
  {
    name: "read inside",
    tool: "Read",
    subject: { kind: "read", paths: [`${P}/src/a.ts`] },
    expect: ["allow", "allow", "allow", "allow", "allow"],
  },
  {
    name: "read outside",
    tool: "Read",
    subject: { kind: "read", paths: ["/etc/hosts"] },
    expect: ["ask", "ask", "ask", "deny", "allow"],
  },
  {
    name: "read outside, allowed by a rule",
    tool: "Read",
    subject: { kind: "read", paths: ["/etc/hosts"] },
    rules: { allow: ["Read(//etc/**)"] },
    expect: ["allow", "allow", "allow", "allow", "allow"],
  },
  {
    name: "search inside",
    tool: "Grep",
    subject: { kind: "read", paths: [P] },
    expect: ["allow", "allow", "allow", "allow", "allow"],
  },
  {
    name: "edit inside",
    tool: "Edit",
    subject: { kind: "edit", paths: [`${P}/src/a.ts`] },
    expect: ["ask", "allow", "deny", "deny", "allow"],
  },
  {
    name: "edit inside, allowed by a rule",
    tool: "Edit",
    subject: { kind: "edit", paths: [`${P}/src/a.ts`] },
    rules: { allow: ["Edit(src/**)"] },
    expect: ["allow", "allow", "deny", "allow", "allow"],
  },
  {
    name: "write outside",
    tool: "Write",
    subject: { kind: "edit", paths: ["/tmp/x.txt"] },
    expect: ["ask", "ask", "deny", "deny", "allow"],
  },
  {
    name: "write outside, even with a rule naming it",
    tool: "Write",
    subject: { kind: "edit", paths: ["/tmp/x.txt"] },
    rules: { allow: ["Edit(//tmp/**)", "Edit"] },
    expect: ["ask", "ask", "deny", "deny", "allow"],
  },
  {
    name: "edit in an added working directory",
    tool: "Edit",
    subject: { kind: "edit", paths: ["/work/shared/lib.ts"] },
    rules: { workingDirectories: [P, "/work/shared"] },
    expect: ["ask", "allow", "deny", "deny", "allow"],
  },
  ...[
    `${P}/.git/config`,
    `${P}/.GIT/hooks/pre-commit`,
    `${P}/.dawg/settings.json`,
    `${P}/.dawg/settings.local.json`,
    `${P}/.claude/settings.json`,
    `${P}/.claude/commands/x.md`,
    `${P}/.husky/pre-commit`,
    `${P}/.vscode/tasks.json`,
    `${P}/.envrc`,
  ].map(
    (p): Row => ({
      name: `protected ${p.slice(P.length + 1)}`,
      tool: "Edit",
      subject: { kind: "edit", paths: [p] },
      rules: { allow: ["Edit", "Edit(**)", "Edit(.git/**)"] },
      expect: ["ask", "ask", "deny", "deny", "allow"],
    }),
  ),
  {
    name: "a session worktree under .dawg is ordinary work",
    tool: "Edit",
    subject: { kind: "edit", paths: [`${P}/.dawg/worktrees/abc/src/a.ts`] },
    expect: ["ask", "allow", "deny", "deny", "allow"],
  },
  {
    name: "read-only command",
    tool: "Bash",
    subject: cmd("ls src && git status"),
    expect: ["allow", "allow", "allow", "allow", "allow"],
  },
  {
    name: "read-only command outside",
    tool: "Bash",
    subject: cmd("cat /etc/hosts"),
    expect: ["ask", "ask", "ask", "deny", "allow"],
  },
  {
    name: "other command",
    tool: "Bash",
    subject: cmd("npm test"),
    expect: ["ask", "ask", "ask", "deny", "allow"],
  },
  {
    name: "other command, allowed by a rule",
    tool: "Bash",
    subject: cmd("npm test"),
    rules: { allow: ["Bash(npm test)"] },
    expect: ["allow", "allow", "ask", "allow", "allow"],
  },
  {
    name: "redirect into the project",
    tool: "Bash",
    subject: cmd("echo hi > out.txt"),
    expect: ["ask", "allow", "deny", "deny", "allow"],
  },
  {
    name: "redirect into the project, command allowed",
    tool: "Bash",
    subject: cmd("npm test > log.txt 2>&1"),
    rules: { allow: ["Bash(npm test)"] },
    expect: ["ask", "allow", "deny", "deny", "allow"],
  },
  {
    name: "redirect outside",
    tool: "Bash",
    subject: cmd("echo hi > /tmp/out.txt"),
    rules: { allow: ["Bash(echo *)", "Edit(//tmp/**)"] },
    expect: ["ask", "ask", "deny", "deny", "allow"],
  },
  {
    name: "redirect into .git with every command allowed",
    tool: "Bash",
    subject: cmd("echo x > .git/config"),
    rules: { allow: ["Bash"] },
    expect: ["ask", "ask", "deny", "deny", "allow"],
  },
  {
    name: "rm inside with a rule",
    tool: "Bash",
    subject: cmd("rm build/out.js"),
    rules: { allow: ["Bash(rm *)"] },
    expect: ["allow", "allow", "ask", "allow", "allow"],
  },
  {
    name: "rm of .git with a rule",
    tool: "Bash",
    subject: cmd("rm -rf .git"),
    rules: { allow: ["Bash(rm *)"] },
    expect: ["ask", "ask", "ask", "deny", "allow"],
  },
  {
    name: "critical removal with a rule",
    tool: "Bash",
    subject: cmd("rm -rf ~"),
    rules: { allow: ["Bash(rm *)", "Bash"] },
    expect: ["ask", "ask", "ask", "deny", "ask"],
  },
  {
    name: "removing the working directory itself",
    tool: "Bash",
    subject: cmd("rm -rf ."),
    rules: { allow: ["Bash"] },
    expect: ["ask", "ask", "ask", "deny", "ask"],
  },
  {
    name: "unparseable command",
    tool: "Bash",
    subject: cmd("f() { ls; }; f"),
    rules: { allow: ["Bash"] },
    expect: ["ask", "ask", "ask", "deny", "ask"],
  },
  {
    name: "ask rule",
    tool: "Bash",
    subject: cmd("git push origin main"),
    rules: { ask: ["Bash(git push *)"], allow: ["Bash"] },
    expect: ["ask", "ask", "ask", "deny", "ask"],
  },
  {
    name: "deny rule",
    tool: "Bash",
    subject: cmd("git push origin main"),
    rules: { deny: ["Bash(git push *)"], allow: ["Bash"] },
    expect: ["deny", "deny", "deny", "deny", "deny"],
  },
  {
    name: "deny rule on an edit",
    tool: "Edit",
    subject: { kind: "edit", paths: [`${P}/.env`] },
    rules: { deny: ["Read(.env)"] },
    expect: ["deny", "deny", "deny", "deny", "deny"],
  },
  {
    name: "other tool",
    tool: "WebFetch",
    subject: { kind: "other", specifier: "domain:example.com" },
    expect: ["ask", "ask", "ask", "deny", "allow"],
  },
  {
    name: "other tool, allowed by a rule",
    tool: "WebFetch",
    subject: { kind: "other", specifier: "domain:example.com" },
    rules: { allow: ["WebFetch(domain:example.com)"] },
    expect: ["allow", "allow", "ask", "allow", "allow"],
  },
  {
    name: "nothing to judge",
    tool: "TodoWrite",
    subject: { kind: "none" },
    expect: ["allow", "allow", "allow", "allow", "allow"],
  },
  {
    name: "a question for the user",
    tool: "AskUserQuestion",
    subject: { kind: "none" },
    rules: { allow: ["AskUserQuestion"] },
    expect: ["allow", "allow", "allow", "deny", "allow"],
  },
  {
    name: "a tool denied by name",
    tool: "TodoWrite",
    subject: { kind: "none" },
    rules: { deny: ["TodoWrite"] },
    expect: ["deny", "deny", "deny", "deny", "deny"],
  },
];

describe("mode table", () => {
  it.each(ROWS)("$name", (row) => {
    const got = MODES.map((mode) => run(row.tool, row.subject, { ...row.rules, mode }));
    const summary = got.map((d) => d.behavior);
    expect(summary, JSON.stringify(got.map((d) => d.reason))).toEqual(row.expect);
  });

  it("explains why plan mode refused an edit", () => {
    const d = edit([`${P}/a.ts`], { mode: "plan" });
    expect(d.behavior).toBe("deny");
    if (d.behavior === "deny") expect(d.message).toMatch(/plan mode/i);
  });

  it("turns every ask into a deny in dontAsk, keeping the reason", () => {
    const d = bash("git push", { mode: "dontAsk", ask: ["Bash(git push *)"] });
    expect(d.behavior).toBe("deny");
    expect(decidingRule(d)).toBe("Bash(git push *)");
    if (d.behavior === "deny") expect(d.message).toMatch(/does not ask/);
  });

  it("lets read-only commands follow deny and ask rules in every mode, plan included", () => {
    for (const mode of MODES) {
      expect(bash("git status", { mode, deny: ["Bash(git status)"] }).behavior, mode).toBe("deny");
    }
    expect(bash("cat .env", { mode: "plan", deny: ["Read(.env)"] }).behavior).toBe("deny");
    expect(bash("ls", { mode: "plan", ask: ["Bash(ls)"] }).behavior).toBe("ask");
  });

  it("can be told to ask before read-only commands outside plan mode", () => {
    const query = { toolName: "Bash", subject: cmd("ls src") };
    const options = { fs: emptyFs, readOnlyCommandsNeverAsk: false };
    expect(decidePermission(query, makeState({ mode: "default" }), options).behavior).toBe("ask");
    expect(decidePermission(query, makeState({ mode: "plan" }), options).behavior).toBe("allow");
    expect(
      decidePermission(query, makeState({ mode: "default", allow: ["Bash(ls *)"] }), options)
        .behavior,
    ).toBe("allow");
  });
});

describe("precedence", () => {
  const dec = (d: PermissionDecision) => [d.behavior, decidingRule(d)];

  it("deny beats allow whichever file each comes from", () => {
    expect(
      dec(
        bash("aws s3 ls", {
          allow: [{ rule: "Bash(aws s3 ls)", from: flags }],
          deny: [{ rule: "Bash(aws *)", from: userFile }],
        }),
      ),
    ).toEqual(["deny", "Bash(aws *)"]);
    expect(
      dec(
        bash("aws s3 ls", {
          allow: [{ rule: "Bash(aws *)", from: userFile }],
          deny: [{ rule: "Bash(aws s3 ls)", from: projectFile }],
        }),
      ),
    ).toEqual(["deny", "Bash(aws s3 ls)"]);
  });

  it("ask beats allow, however specific the allow", () => {
    expect(
      dec(
        bash("git push origin main", {
          allow: ["Bash(git push origin main)"],
          ask: ["Bash(git push *)"],
        }),
      ),
    ).toEqual(["ask", "Bash(git push *)"]);
  });

  it("deny beats ask", () => {
    expect(dec(bash("git push", { ask: ["Bash(git push)"], deny: ["Bash(git push)"] }))).toEqual([
      "deny",
      "Bash(git push)",
    ]);
  });

  it("reports the first matching rule in precedence order", () => {
    const deny: RuleInput[] = [
      { rule: "Bash(rm *)", from: flags },
      { rule: "Bash(rm -rf *)", from: localFile },
      { rule: "Bash", from: userFile },
    ];
    expect(decidingRule(bash("rm -rf x", { deny: deny.slice(0, 2) }))).toBe("Bash(rm *)");
    // A bare tool deny is checked before the command is even read.
    expect(decidingRule(bash("rm -rf x", { deny }))).toBe("Bash");
  });

  it("applies a deny from any source to every part of a command", () => {
    const d = bash("ls && rm x", {
      allow: [{ rule: "Bash", from: localFile }],
      deny: [{ rule: "Bash(rm *)", from: userFile }],
    });
    expect(d.behavior).toBe("deny");
    expect(d.reason.type).toBe("command_part");
  });

  it("allow rules have no effect in bypass mode but deny rules still apply", () => {
    expect(bash("anything", { mode: "bypassPermissions" }).behavior).toBe("allow");
    expect(bash("rm x", { mode: "bypassPermissions", deny: ["Bash(rm *)"] }).behavior).toBe("deny");
    expect(
      read(["/etc/passwd"], { mode: "bypassPermissions", deny: ["Read(//etc/**)"] }).behavior,
    ).toBe("deny");
  });

  it("says truthfully what decided", () => {
    expect(reasonType(bash("ls"))).toBe("mode");
    expect(reasonType(bash("npm test", { allow: ["Bash(npm test)"] }))).toBe("rule");
    expect(reasonType(edit([`${P}/.git/x`]))).toBe("protected:git");
    expect(reasonType(edit(["/tmp/x"]))).toBe("protected:outside_working_directories");
    expect(reasonType(bash("f() { :; }"))).toBe("unparseable_command");
    expect(run("TodoWrite", { kind: "none" }).reason).toEqual({ type: "not_needed" });
    const multi = bash("ls && npm test");
    expect(multi.reason).toMatchObject({
      type: "command_part",
      part: "npm test",
      reason: { type: "mode" },
    });
  });

  it("reads outside the working directories are judged like the documented default: approval unless a rule allows", () => {
    expect(read([`${HOME}/notes.md`]).behavior).toBe("ask");
    expect(read([`${HOME}/notes.md`], { allow: ["Read(~/notes.md)"] }).behavior).toBe("allow");
    expect(read([`${HOME}/notes.md`], { allow: ["Read"] }).behavior).toBe("allow");
  });
});
