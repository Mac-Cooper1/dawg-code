/**
 * Symbolic links, `..` and case, on a real temporary directory. On macOS the temporary directory
 * itself sits behind a link (/var -> /private/var), which these tests also exercise.
 */
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PermissionSubject } from "../contracts/permissions.ts";
import type { StateInput } from "./__fixtures__/helpers.ts";
import { makeState, reasonType } from "./__fixtures__/helpers.ts";
import { decidePermission } from "./decide.ts";
import { nodeFsProbe } from "./paths.ts";

let root: string;
let home: string;
let proj: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "dawg-permissions-"));
  home = path.join(root, "home");
  proj = path.join(root, "proj");
  outside = path.join(root, "outside");
  for (const d of [
    `${home}/.ssh`,
    `${proj}/src`,
    `${proj}/project`,
    `${proj}/.git/hooks`,
    `${proj}/.dawg`,
    outside,
    `${root}/realsecrets`,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(`${home}/.ssh/id_rsa`, "key");
  writeFileSync(`${proj}/src/a.ts`, "");
  writeFileSync(`${proj}/.dawg/settings.json`, "{}");
  writeFileSync(`${root}/realsecrets/a`, "");
  symlinkSync(`${home}/.ssh/id_rsa`, `${proj}/project/key`);
  symlinkSync(outside, `${proj}/out`);
  symlinkSync(`${proj}/.git/hooks`, `${proj}/hooks`);
  symlinkSync(".dawg/settings.json", `${proj}/settings-link.json`);
  symlinkSync("loop2", `${proj}/loop1`);
  symlinkSync("loop1", `${proj}/loop2`);
  symlinkSync(proj, `${root}/alias`);
  symlinkSync(`${root}/realsecrets`, `${root}/linksecrets`);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function decide(toolName: string, subject: PermissionSubject, input: StateInput = {}) {
  const state = makeState({ cwd: proj, homeDir: home, ...input });
  return decidePermission({ toolName, subject }, state, { fs: nodeFsProbe });
}
const read = (p: string, input?: StateInput) => decide("Read", { kind: "read", paths: [p] }, input);
const edit = (p: string, input?: StateInput) => decide("Edit", { kind: "edit", paths: [p] }, input);
const bash = (command: string, input?: StateInput) =>
  decide("Bash", { kind: "command", command }, input);
const from = () => ({
  source: "project" as const,
  origin: "dawg" as const,
  path: `${proj}/.dawg/settings.json`,
});

describe("symbolic links", () => {
  it("treats the working directory by its real location (the temporary directory may be a link)", () => {
    expect(read(`${proj}/src/a.ts`).behavior).toBe("allow");
    expect(edit(`${proj}/src/a.ts`, { mode: "acceptEdits" }).behavior).toBe("allow");
  });

  it("denies a link that leads to a denied file (documented example)", () => {
    const d = read(`${proj}/project/key`, {
      allow: [{ rule: "Read(./project/**)", from: from() }],
      deny: [{ rule: "Read(~/.ssh/**)", from: from() }],
    });
    expect(d.behavior).toBe("deny");
  });

  it("does not let an allow rule cover a link that leads outside what it names", () => {
    const d = read(`${proj}/project/key`, {
      allow: [{ rule: "Read(./project/**)", from: from() }],
    });
    expect(d.behavior).toBe("ask");
  });

  it("counts a path as inside only when where it leads is inside", () => {
    const d = edit(`${proj}/out/x.txt`, { mode: "acceptEdits" });
    expect(d.behavior).toBe("ask");
    expect(reasonType(d)).toBe("protected:outside_working_directories");
    // The reverse: a path outside that leads inside is inside.
    expect(edit(`${root}/alias/src/a.ts`, { mode: "acceptEdits" }).behavior).toBe("allow");
  });

  it("protects a path that leads into .git or a settings file", () => {
    expect(reasonType(edit(`${proj}/hooks/pre-commit`, { mode: "acceptEdits" }))).toBe(
      "protected:git",
    );
    expect(
      reasonType(edit(`${proj}/settings-link.json`, { mode: "acceptEdits", allow: ["Edit"] })),
    ).toBe("protected:settings");
    expect(edit(`${proj}/hooks/pre-commit`, { mode: "bypassPermissions" }).behavior).toBe("allow");
  });

  it("asks when a path cannot be resolved (a link loop)", () => {
    expect(edit(`${proj}/loop1/x`, { mode: "acceptEdits" }).behavior).toBe("ask");
    expect(read(`${proj}/loop1`).behavior).toBe("ask");
  });

  it("applies a deny written through a linked directory to the real location, and the reverse", () => {
    const viaLink = [{ rule: `Read(/${root}/linksecrets/**)`, from: from() }];
    expect(read(`${root}/realsecrets/a`, { deny: viaLink }).behavior).toBe("deny");
    const viaReal = [{ rule: `Read(/${root}/realsecrets/**)`, from: from() }];
    expect(read(`${root}/linksecrets/a`, { deny: viaReal }).behavior).toBe("deny");
  });

  it("follows a redirection through a link", () => {
    const d = bash("echo hi > out/file.txt", { mode: "acceptEdits", allow: ["Bash(echo *)"] });
    expect(d.behavior).toBe("ask");
    expect(reasonType(d)).toBe("protected:outside_working_directories");
    expect(bash("echo hi > src/b.txt", { mode: "acceptEdits" }).behavior).toBe("allow");
  });

  it.runIf(process.platform === "darwin" && lstatSync("/etc").isSymbolicLink())(
    "macOS: Read(//etc/**) also blocks /private/etc",
    () => {
      expect(read("/private/etc/hosts", { deny: ["Read(//etc/**)"] }).behavior).toBe("deny");
      expect(read("/etc/hosts", { deny: ["Read(//private/etc/**)"] }).behavior).toBe("deny");
    },
  );
});

describe("..", () => {
  it("resolves .. in a tool's path lexically, as the tools do", () => {
    expect(edit(`${proj}/../outside/x`, { mode: "acceptEdits" }).behavior).toBe("ask");
    expect(edit(`${proj}/src/../src/a.ts`, { mode: "acceptEdits" }).behavior).toBe("allow");
  });

  it("resolves .. after a link in a shell path the way the kernel does", () => {
    // Lexically this is proj/secret; the kernel goes to the parent of `outside`.
    const d = bash("cat out/../secret");
    expect(d.behavior).toBe("ask");
    expect(bash("cat src/../src/a.ts").behavior).toBe("allow");
  });
});

describe("case", () => {
  it("protects .GIT like .git", () => {
    expect(reasonType(edit(`${proj}/.GIT/config`, { mode: "acceptEdits" }))).toBe("protected:git");
    expect(reasonType(edit(`${proj}/.Dawg/settings.json`, { mode: "acceptEdits" }))).toBe(
      "protected:settings",
    );
    expect(bash("echo x > .Git/config", { mode: "acceptEdits", allow: ["Bash"] }).behavior).toBe(
      "ask",
    );
  });

  it("ignores invisible characters a file system might drop", () => {
    expect(reasonType(edit(`${proj}/.g‌it/config`, { mode: "acceptEdits" }))).toBe("protected:git");
  });
});
