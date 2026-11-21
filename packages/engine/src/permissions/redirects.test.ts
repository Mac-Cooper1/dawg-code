/**
 * A file a command writes through a redirection is a file edit: judged by edit rules and the
 * mode's default for edits, whatever Bash rule approved the command. Also: the shell's own
 * directory, critical removals and internal failures.
 */
import type { PermissionMode } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import type { PermissionDecision, PermissionState } from "../contracts/permissions.ts";
import {
  bash,
  emptyFs,
  localFile,
  makeState,
  PROJECT,
  reasonType,
  type StateInput,
} from "./__fixtures__/helpers.ts";
import { decidePermission } from "./decide.ts";
import { describePermissionRequest } from "./wording.ts";

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];
const RULES = ["Bash(git status *)", "Bash(echo *)"];
const P = PROJECT;

const inMode = (command: string, mode: PermissionMode, extra: StateInput = {}) =>
  bash(command, { allow: [...RULES, ...(extra.allow ?? [])], ...extra, mode }).behavior;

describe("a redirection is an edit", () => {
  it.each(["git status > out.txt", "echo x > src/a.ts"])(
    "%j follows the mode's rule for edits",
    (command) => {
      expect(inMode(command, "default")).toBe("ask");
      expect(inMode(command, "acceptEdits")).toBe("allow");
      expect(inMode(command, "dontAsk")).toBe("deny");
      expect(inMode(command, "plan")).not.toBe("allow");
      expect(inMode(command, "plan")).toBe("deny");
      expect(inMode(command, "bypassPermissions")).toBe("allow");
    },
  );

  it.each([
    "git status 2> err.txt",
    "git status >> log.txt",
    "git status &> all.txt",
    "git status &>> all.txt",
    "echo x >| clobber.txt",
    "echo x 3> fd3.txt",
    "echo x >& out.txt",
    "echo x <> rw.txt",
  ])("%j: every writing redirection counts", (command) => {
    expect(inMode(command, "default")).toBe("ask");
    expect(inMode(command, "acceptEdits")).toBe("allow");
  });

  it.each([
    "echo x > /dev/null",
    "echo x 2>&1",
    "echo x 2>/dev/null >/dev/stderr",
    "echo x > /dev/stdout",
    "echo x > /dev/tty",
    "echo x > /dev/fd/2",
    "git status >&2",
    "git status 2>&-",
  ])("%j is not a write", (command) => {
    for (const mode of MODES) expect(inMode(command, mode), mode).toBe("allow");
  });

  it("is allowed in default mode by an edit allow rule covering the target", () => {
    expect(inMode("echo x > src/a.ts", "default", { allow: ["Edit(/src/**)"] })).toBe("allow");
    expect(inMode("git status > out.txt", "default", { allow: ["Edit(/out.txt)"] })).toBe("allow");
    expect(inMode("git status > out.txt", "default", { allow: ["Edit"] })).toBe("allow");
    // An edit rule for another file does not help.
    expect(inMode("echo x > src/a.ts", "default", { allow: ["Edit(/docs/**)"] })).toBe("ask");
  });

  it("is denied in every mode, bypass included, by an edit deny rule covering the target", () => {
    for (const mode of MODES) {
      expect(inMode("echo x > src/a.ts", mode, { deny: ["Edit(src/**)"] }), mode).toBe("deny");
      expect(inMode("echo x > .env", mode, { deny: ["Read(.env)"] }), mode).toBe("deny");
    }
  });

  it("asks in every mode, bypass included, when an edit ask rule covers the target", () => {
    for (const mode of ["default", "acceptEdits", "bypassPermissions"] as const) {
      expect(inMode("echo x > src/a.ts", mode, { ask: ["Edit(src/a.ts)"] }), mode).toBe("ask");
    }
  });

  it("still asks before writing a protected path, whatever allows the edit", () => {
    for (const mode of ["default", "acceptEdits"] as const) {
      const d = bash("echo x > .git/hooks/pre-commit", { mode, allow: [...RULES, "Edit", "Bash"] });
      expect(d.behavior, mode).toBe("ask");
      expect(reasonType(d)).toBe("protected:git");
    }
  });

  it("says which target decided", () => {
    const d = bash("echo x > notes.md > src/a.ts", { allow: RULES, mode: "default" });
    expect(d.reason).toEqual({
      type: "command_part",
      part: "> notes.md",
      reason: { type: "mode", mode: "default" },
    });
    const outside = bash("echo x > notes.md > /tmp/b", { allow: RULES, mode: "acceptEdits" });
    expect(outside.reason).toEqual({
      type: "command_part",
      part: "> /tmp/b",
      reason: { type: "protected", path: "/tmp/b", why: "outside_working_directories" },
    });
    const ruled = bash("echo x > src/a.ts", { allow: RULES, deny: ["Edit(src/**)"] });
    expect(ruled.reason).toMatchObject({
      type: "command_part",
      part: "> src/a.ts",
      reason: { type: "rule" },
    });
    const q = {
      toolName: "Bash",
      subject: { kind: "command" as const, command: "echo x > src/a.ts" },
    };
    expect(
      describePermissionRequest(q, bash("echo x > src/a.ts", { allow: RULES }), { cwd: P }).reason,
    ).toBe("`> src/a.ts`: no rule allows this edit.");
  });

  it("lets the most restrictive outcome win across the command and its targets", () => {
    // The command needs approval and a target is denied: deny.
    expect(bash("npm test > src/a.ts", { deny: ["Edit(src/**)"] }).behavior).toBe("deny");
    // Plan mode blocks the edit even though an ask rule would only have asked.
    expect(
      bash("echo x > a.txt", { mode: "plan", allow: RULES, ask: ["Edit(a.txt)"] }).behavior,
    ).toBe("deny");
    // Read-only part, redirected part: the redirect decides.
    expect(bash("ls && echo x > a.txt", { allow: RULES }).behavior).toBe("ask");
  });

  it("leaves a program's own output files to its allow rule", () => {
    for (const [command, rule] of [
      ["tee notes.txt", "Bash(tee *)"],
      ["cp a.txt b.txt", "Bash(cp *)"],
      ["sed -i 's/a/b/' src/a.ts", "Bash(sed *)"],
      ["sort -o sorted.txt in.txt", "Bash(sort *)"],
    ] as const) {
      expect(bash(command, { allow: [rule] }).behavior, command).toBe("allow");
    }
    // ...but a redirection on the same command is still an edit.
    expect(bash("tee notes.txt > copy.txt", { allow: ["Bash(tee *)"] }).behavior).toBe("ask");
  });

  it("keeps the redirection of exec on its own as an edit", () => {
    expect(bash("exec > log.txt", { allow: ["Bash"] }).behavior).toBe("ask");
    expect(bash("exec > log.txt", { mode: "acceptEdits" }).behavior).toBe("allow");
  });
});

describe("suggestions for redirections", () => {
  const offered = (d: PermissionDecision) => (d.behavior === "ask" ? d.suggestions : []);

  it("include the edit rule the target needs", () => {
    expect(offered(bash("echo x > src/a.ts", { allow: RULES }))).toEqual(["Edit(/src/**)"]);
    expect(offered(bash("git status > out.txt", { allow: RULES }))).toEqual(["Edit(/out.txt)"]);
    expect(offered(bash("npm test > logs/test.log 2>&1"))).toEqual([
      "Bash(npm test *)",
      "Edit(/logs/**)",
    ]);
  });

  it("really allow the call once saved", () => {
    for (const command of [
      "echo x > src/a.ts",
      "git status > out.txt",
      "npm test > logs/test.log 2>&1",
      "git status 2> err.txt && echo done >> log.txt",
    ]) {
      const state = makeState({ allow: RULES });
      const d = decidePermission(
        { toolName: "Bash", subject: { kind: "command", command } },
        state,
        { fs: emptyFs },
      );
      expect(d.behavior, command).toBe("ask");
      const saved: PermissionState = {
        ...state,
        rules: {
          ...state.rules,
          allow: [...state.rules.allow, ...offered(d).map((rule) => ({ rule, from: localFile }))],
        },
      };
      const again = decidePermission(
        { toolName: "Bash", subject: { kind: "command", command } },
        saved,
        {
          fs: emptyFs,
        },
      );
      expect(again.behavior, command).toBe("allow");
    }
  });

  it("are not offered for protected or outside targets", () => {
    expect(offered(bash("echo x > .git/config", { allow: RULES }))).toEqual([]);
    expect(offered(bash("echo x > /tmp/x", { allow: RULES }))).toEqual([]);
  });
});

describe("the shell's own directory", () => {
  const withCwd = (command: string, cwd: string, mode: PermissionMode = "acceptEdits") =>
    decidePermission(
      { toolName: "Bash", subject: { kind: "command", command, cwd } },
      makeState({ mode, allow: RULES }),
      { fs: emptyFs },
    );

  it("resolves relative paths against the directory the shell is in", () => {
    expect(withCwd("echo x > a.txt", "/tmp").behavior).toBe("ask");
    expect(reasonType(withCwd("echo x > a.txt", "/tmp"))).toBe(
      "protected:outside_working_directories",
    );
    expect(withCwd("echo x > a.txt", `${P}/src`).behavior).toBe("allow");
    expect(withCwd("cat notes.md", "/etc", "default").behavior).toBe("ask");
    expect(withCwd("echo x > hooks/pre-commit", `${P}/.git`).behavior).toBe("ask");
  });

  it("falls back to the session's directory when the shell's is not absolute", () => {
    expect(withCwd("echo x > a.txt", "relative/dir").behavior).toBe("allow");
  });
});

describe("new reasons", () => {
  it("reports critical removals as such", () => {
    expect(bash("rm -rf ~", { allow: ["Bash"] }).reason).toEqual({
      type: "critical_removal",
      path: "/home/alice",
    });
    expect(bash('rm -rf "$DIR"', { allow: ["Bash"], mode: "bypassPermissions" }).reason).toEqual({
      type: "critical_removal",
      path: null,
    });
    expect(bash("rm -rf .", { allow: ["Bash"] }).reason).toEqual({
      type: "critical_removal",
      path: P,
    });
  });

  it("reports a failure inside the check as an internal error, and fails safe", () => {
    const broken = (mode: PermissionMode): PermissionState => {
      const state = makeState({ mode });
      return Object.defineProperty({ ...state }, "workingDirectories", {
        get() {
          throw new Error("broken");
        },
      }) as PermissionState;
    };
    const q = { toolName: "Bash", subject: { kind: "command" as const, command: "ls" } };
    const d = decidePermission(q, broken("default"), { fs: emptyFs });
    expect(d).toEqual({ behavior: "ask", reason: { type: "internal_error" }, suggestions: [] });
    expect(decidePermission(q, broken("dontAsk"), { fs: emptyFs }).behavior).toBe("deny");
    expect(decidePermission(q, broken("bypassPermissions"), { fs: emptyFs }).behavior).toBe("ask");
  });
});
