/**
 * The permission engine with the sandbox on (Phase 4): auto-allow lifts only the prompts the
 * mode would raise, and a retry outside the sandbox is a normal, read-only-or-not, prompt.
 */
import { describe, expect, test } from "vitest";
import type { CommandSandboxPlan } from "../contracts/permissions.ts";
import {
  decidingRule,
  HOME,
  PROJECT,
  reasonType,
  run,
  type StateInput,
} from "./__fixtures__/helpers.ts";

const inside = (autoAllow: boolean): CommandSandboxPlan => ({ run: "inside", autoAllow });
const retry: CommandSandboxPlan = { run: "outside", why: "retry" };
const excluded: CommandSandboxPlan = { run: "outside", why: "excluded" };

function bash(command: string, sandbox: CommandSandboxPlan | undefined, input: StateInput = {}) {
  return run(
    "Bash",
    sandbox === undefined ? { kind: "command", command } : { kind: "command", command, sandbox },
    input,
  );
}

describe("auto-allow for sandboxed commands", () => {
  test("allows what only the mode would have asked about", () => {
    expect(bash("npm install", inside(false)).behavior).toBe("ask");
    const d = bash("npm install", inside(true));
    expect(d.behavior).toBe("allow");
    expect(reasonType(d)).toBe("sandbox");
  });

  test("lets the sandbox judge writes and reads outside the working directories", () => {
    expect(bash("echo x > /etc/hosts", inside(false)).behavior).toBe("ask");
    expect(bash("echo x > /etc/hosts", inside(true)).behavior).toBe("allow");
    expect(bash(`cp ${HOME}/notes.txt .`, inside(true)).behavior).toBe("allow");
  });

  test("deny rules still deny", () => {
    const d = bash("rm -rf build", inside(true), { deny: ["Bash(rm *)"] });
    expect(d.behavior).toBe("deny");
    expect(decidingRule(d)).toBe("Bash(rm *)");
    expect(bash("cat .env", inside(true), { deny: ["Read(.env)"] }).behavior).toBe("deny");
  });

  test("ask rules that name a command still ask; a bare Bash ask rule does not", () => {
    const d = bash("git push origin main", inside(true), { ask: ["Bash(git push *)"] });
    expect(d.behavior).toBe("ask");
    expect(decidingRule(d)).toBe("Bash(git push *)");
    expect(bash("npm test", inside(true), { ask: ["Bash"] }).behavior).toBe("allow");
    expect(bash("npm test", inside(false), { ask: ["Bash"] }).behavior).toBe("ask");
  });

  test("critical removals, protected paths and unanalysable commands still ask", () => {
    expect(reasonType(bash(`rm -rf ${HOME}`, inside(true)))).toBe("critical_removal");
    expect(reasonType(bash("echo x > .git/config", inside(true)))).toBe("protected:git");
    expect(reasonType(bash("echo '{}' > .dawg/settings.json", inside(true)))).toBe(
      "protected:settings",
    );
    expect(reasonType(bash('eval "$CMD"', inside(true)))).toBe("unparseable_command");
  });

  test("plan mode is not lifted", () => {
    expect(bash("npm install", inside(true), { mode: "plan" }).behavior).toBe("ask");
    expect(bash("npm test", inside(true), { mode: "plan", ask: ["Bash"] }).behavior).toBe("ask");
  });

  test("works whatever the other modes, dontAsk included", () => {
    expect(bash("npm install", inside(true), { mode: "dontAsk" }).behavior).toBe("allow");
    expect(bash("npm install", inside(true), { mode: "acceptEdits" }).behavior).toBe("allow");
  });
});

describe("commands outside the sandbox", () => {
  test("a retry outside asks even for a read-only command", () => {
    expect(bash("ls src", undefined).behavior).toBe("allow");
    expect(bash("ls src", inside(false)).behavior).toBe("allow");
    const d = bash("ls src", retry);
    expect(d.behavior).toBe("ask");
    expect(reasonType(d)).toBe("mode");
  });

  test("an allow rule approves a retry, as documented; bypass mode does too", () => {
    expect(bash("curl https://example.com", retry, { allow: ["Bash(curl *)"] }).behavior).toBe(
      "allow",
    );
    expect(bash("curl https://example.com", retry, { mode: "bypassPermissions" }).behavior).toBe(
      "allow",
    );
    expect(bash("curl https://example.com", retry, { mode: "dontAsk" }).behavior).toBe("deny");
  });

  test("an excluded command follows the normal flow", () => {
    expect(bash("docker compose up", excluded).behavior).toBe("ask");
    expect(bash("docker ps", excluded, { allow: ["Bash(docker *)"] }).behavior).toBe("allow");
    // Read-only commands need no prompt outside, as anywhere.
    expect(bash("ls", excluded, { cwd: PROJECT }).behavior).toBe("allow");
  });

  test("auto-allow does not reach commands that run outside", () => {
    expect(bash("docker compose up", excluded, { mode: "default" }).behavior).toBe("ask");
  });
});
