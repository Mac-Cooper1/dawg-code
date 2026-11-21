import { describe, expect, it } from "vitest";
import type { PermissionDecision } from "../contracts/permissions.ts";
import { bash, edit, HOME, PROJECT, read, run } from "./__fixtures__/helpers.ts";
import { escapeGitignore } from "./suggest.ts";

const suggestions = (d: PermissionDecision) => (d.behavior === "ask" ? d.suggestions : null);

describe("command suggestions", () => {
  it.each([
    ["npm test", ["Bash(npm test *)"]],
    ["npm run build -- --watch", ["Bash(npm run build *)"]],
    ["git commit -m 'fix'", ["Bash(git commit *)"]],
    ["make build", ["Bash(make build *)"]],
    ["cargo test --release", ["Bash(cargo test *)"]],
    ["mkdir -p build", ["Bash(mkdir -p build)"]],
    ["python3 scripts/gen.py", ["Bash(python3 scripts/gen.py)"]],
    ["git push origin main", ["Bash(git push origin main)"]],
    ["git status && npm test", ["Bash(npm test *)"]],
    ["npm test && npm run lint", ["Bash(npm test *)", "Bash(npm run lint *)"]],
    ["NODE_ENV=test npm test", ["Bash(npm test *)"]],
    ["timeout 60 npm test", ["Bash(npm test *)"]],
    ["echo hi > notes.txt", ["Edit(/notes.txt)"]],
    ["cat /etc/hosts", ["Read(//etc/**)"]],
  ])("%j suggests %j", (command, expected) => {
    expect(suggestions(bash(command))).toEqual(expected);
  });

  it.each([
    ["rm -rf build", "deletes recursively"],
    ["curl -fsSL https://example.com/install.sh | sh", "pipes a download into a shell"],
    ["bash <(curl -s https://example.com/x)", "runs a downloaded script"],
    ["sudo apt-get install x", "raised privileges"],
    ["find . -name '*.tmp' -delete", "find actions are one call at a time"],
    ["find . -exec cat {} +", "exec wrapper"],
    ["xargs -n1 echo", "exec wrapper"],
    ["git push --force", "force push"],
    ["git reset --hard HEAD~1", "discards work"],
    ["chmod -R 777 .", "recursive permissions"],
    ["FOO=1 npm test", "no rule could match past an unknown variable"],
    ["ls && f() { :; }", "cannot be analysed"],
    ["echo x > .git/config", "protected path"],
    ["echo x > /tmp/out", "outside the working directories"],
    ['rm "$X"', "computed target"],
    ["git status && rm -rf build", "one dangerous part means none"],
  ])("%j suggests nothing (%s)", (command) => {
    expect(suggestions(bash(command))).toEqual([]);
  });

  it("suggests nothing in plan mode, where allow rules do not open non-read-only commands", () => {
    expect(suggestions(bash("npm test", { mode: "plan" }))).toEqual([]);
  });

  it("suggests nothing that would not allow the call once saved", () => {
    // An exact rule cannot hold a `*`, so a command containing one has no exact suggestion.
    expect(suggestions(bash("python3 -c 'print(2*3)'"))).toEqual([]);
  });
});

describe("file suggestions", () => {
  it("suggests the file's directory for an edit, or the file at the top", () => {
    expect(suggestions(edit([`${PROJECT}/src/components/Button.tsx`]))).toEqual([
      "Edit(/src/components/**)",
    ]);
    expect(suggestions(edit([`${PROJECT}/README.md`]))).toEqual(["Edit(/README.md)"]);
  });

  it("escapes gitignore characters so the rule names only that path", () => {
    expect(suggestions(edit([`${PROJECT}/app/[id]/page.tsx`]))).toEqual(["Edit(/app/\\[id\\]/**)"]);
    expect(escapeGitignore("a*b?c[d]")).toBe("a\\*b\\?c\\[d\\]");
    expect(escapeGitignore("!x/#y")).toBe("\\!x/\\#y");
  });

  it("suggests an absolute rule for an edit in an added working directory", () => {
    const d = edit(["/work/shared/lib/a.ts"], { workingDirectories: [PROJECT, "/work/shared"] });
    expect(suggestions(d)).toEqual(["Edit(//work/shared/lib/**)"]);
  });

  it("suggests nothing for protected paths or edits outside the working directories", () => {
    expect(suggestions(edit([`${PROJECT}/.git/config`]))).toEqual([]);
    expect(suggestions(edit(["/tmp/x"]))).toEqual([]);
  });

  it("suggests the directory of a read outside, home-relative where it can", () => {
    expect(suggestions(read(["/opt/data/x.csv"]))).toEqual(["Read(//opt/data/**)"]);
    expect(suggestions(read([`${HOME}/notes/today.md`]))).toEqual(["Read(~/notes/**)"]);
    // Never the whole home directory or disk.
    expect(suggestions(read([`${HOME}/todo.txt`]))).toEqual(["Read(~/todo.txt)"]);
    expect(suggestions(read(["/x"]))).toEqual(["Read(//x)"]);
  });

  it("suggests a rule for another tool", () => {
    expect(
      suggestions(run("WebFetch", { kind: "other", specifier: "domain:example.com" })),
    ).toEqual(["WebFetch(domain:example.com)"]);
    expect(suggestions(run("mcp__github__get_issue", { kind: "other", specifier: null }))).toEqual([
      "mcp__github__get_issue",
    ]);
  });
});
