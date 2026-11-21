/**
 * Read and Edit path patterns, using the examples from the public permissions documentation.
 * Paths here do not exist, so each is its own real path (see symlinks.test.ts for real files).
 */
import { describe, expect, it } from "vitest";
import {
  edit,
  flags,
  HOME,
  localFile,
  PROJECT,
  projectFile,
  read,
  run,
  userFile,
} from "./__fixtures__/helpers.ts";

const P = PROJECT;

/** Whether a deny rule blocks reading the path. */
const blocksRead = (rule: string, path: string, from = projectFile) =>
  read([path], { deny: [{ rule, from }] }).behavior === "deny";
/** Whether a deny rule blocks editing the path. */
const blocksEdit = (rule: string, path: string, from = projectFile) =>
  edit([path], { deny: [{ rule, from }] }).behavior === "deny";
/** Whether an allow rule lets an edit inside the project through in the default mode. */
const allowsEdit = (rule: string, path: string, from = projectFile) =>
  edit([path], { allow: [{ rule, from }] }).behavior === "allow";
/** Whether an allow rule lets a read outside the working directories through. */
const allowsRead = (rule: string, path: string, from = projectFile) =>
  read([path], { allow: [{ rule, from }] }).behavior === "allow";

describe("the four anchoring forms", () => {
  it("//path is absolute from the filesystem root", () => {
    expect(blocksRead("Read(//Users/alice/secrets/**)", "/Users/alice/secrets/key.pem")).toBe(true);
    expect(blocksRead("Read(//Users/alice/secrets/**)", `${P}/Users/alice/secrets/key.pem`)).toBe(
      false,
    );
    expect(allowsRead("Edit(//tmp/scratch.txt)", "/tmp/scratch.txt")).toBe(false);
    expect(blocksEdit("Edit(//tmp/scratch.txt)", "/tmp/scratch.txt")).toBe(true);
  });

  it("~/path is relative to the home directory", () => {
    expect(allowsRead("Read(~/Documents/*.pdf)", `${HOME}/Documents/report.pdf`)).toBe(true);
    expect(allowsRead("Read(~/Documents/*.pdf)", `${HOME}/Documents/sub/report.pdf`)).toBe(false);
    expect(allowsRead("Read(~/.zshrc)", `${HOME}/.zshrc`)).toBe(true);
    expect(allowsRead("Read(~/.zshrc)", "/etc/zshrc")).toBe(false);
  });

  it("/path is relative to the settings source", () => {
    // Project, local, flags: the primary working directory.
    for (const from of [projectFile, localFile, flags]) {
      expect(allowsEdit("Edit(/src/**/*.ts)", `${P}/src/a/b.ts`, from)).toBe(true);
      expect(allowsEdit("Edit(/src/**/*.ts)", `${P}/src/a/b.js`, from)).toBe(false);
    }
    // User settings: the directory of the user settings file.
    expect(blocksRead("Read(/secrets/**)", `${HOME}/.claude/secrets/x`, userFile)).toBe(true);
    expect(blocksRead("Read(/secrets/**)", `${P}/secrets/x`, userFile)).toBe(false);
    const dawgUser = {
      source: "user" as const,
      origin: "dawg" as const,
      path: `${HOME}/.dawg/settings.json`,
    };
    expect(blocksRead("Read(/secrets/**)", `${HOME}/.dawg/secrets/x`, dawgUser)).toBe(true);
  });

  it("a single leading slash is not an absolute path", () => {
    expect(blocksRead("Read(/Users/alice/file)", "/Users/alice/file")).toBe(false);
    expect(blocksRead("Read(/Users/alice/file)", `${P}/Users/alice/file`)).toBe(true);
  });

  it("path and ./path are relative to the working directory", () => {
    expect(blocksRead("Read(*.env)", `${P}/prod.env`)).toBe(true);
    expect(blocksRead("Read(./.env)", `${P}/.env`)).toBe(true);
    expect(allowsEdit("Edit(./notes.md)", `${P}/notes.md`)).toBe(true);
  });

  it("documented examples for Edit(/docs/**)", () => {
    expect(blocksEdit("Edit(/docs/**)", `${P}/docs/a.md`)).toBe(true);
    expect(blocksEdit("Edit(/docs/**)", "/docs/a.md")).toBe(false);
    expect(blocksEdit("Edit(/docs/**)", `${P}/.claude/docs/a.md`)).toBe(false);
  });
});

describe("depth", () => {
  const app = `${P}/src/app.ts`;
  const nested = `${P}/vendor/pkg/src/lib.js`;

  it("follows the documented table", () => {
    expect(allowsEdit("Edit(src/**)", app)).toBe(true);
    expect(allowsEdit("Edit(src/**)", nested)).toBe(false);
    expect(blocksEdit("Edit(src/**)", app)).toBe(true);
    expect(blocksEdit("Edit(src/**)", nested)).toBe(true);
    expect(allowsEdit("Edit(/src/**)", app)).toBe(true);
    expect(allowsEdit("Edit(/src/**)", nested)).toBe(false);
    expect(blocksEdit("Edit(/src/**)", nested)).toBe(false);
    expect(allowsEdit("Edit(**/src/**)", nested)).toBe(true);
    expect(blocksEdit("Edit(**/src/**)", nested)).toBe(true);
    expect(blocksEdit("Edit(src/components/**)", `${P}/a/src/components/x.tsx`)).toBe(false);
  });

  it("matches bare file names at any depth below the working directory only", () => {
    for (const rule of ["Read(.env)", "Read(**/.env)"]) {
      expect(blocksRead(rule, `${P}/.env`)).toBe(true);
      expect(blocksRead(rule, `${P}/a/b/.env`)).toBe(true);
      expect(blocksRead(rule, "/work/.env")).toBe(false);
      expect(blocksRead(rule, "/elsewhere/project/.env")).toBe(false);
    }
    expect(blocksRead("Read(//**/.env)", "/anywhere/at/all/.env")).toBe(true);
  });

  it("treats a deny on a directory's contents as covering a read of the directory", () => {
    expect(blocksRead("Read(secrets/**)", `${P}/secrets`)).toBe(true);
    expect(blocksRead("Read(secrets/**)", `${P}/secrets/a/b`)).toBe(true);
    expect(blocksRead("Read(.env)", P)).toBe(false);
  });
});

describe("special characters and ! carve-outs", () => {
  it("reads parentheses literally", () => {
    expect(blocksEdit("Edit(./Finance (2024)/**)", `${P}/Finance (2024)/q1.xlsx`)).toBe(true);
    expect(blocksEdit("Edit(./Finance (2024)/**)", `${P}/Finance 2024/q1.xlsx`)).toBe(false);
  });

  it("carves exceptions out of earlier rules in the same file", () => {
    const deny = ["Read(*.env)", "Read(!sample.env)"];
    expect(read([`${P}/prod.env`], { deny }).behavior).toBe("deny");
    expect(read([`${P}/sample.env`], { deny }).behavior).toBe("allow");
    expect(read([`${P}/a/sample.env`], { deny }).behavior).toBe("allow");
  });

  it("does not carve out of rules from another source", () => {
    const deny = [
      { rule: "Read(./.env)", from: userFile },
      { rule: "Read(!.env)", from: projectFile },
    ];
    expect(read([`${P}/.env`], { deny }).behavior).toBe("deny");
  });

  it("carves nothing when the ! rule comes first", () => {
    expect(read([`${P}/sample.env`], { deny: ["Read(!sample.env)", "Read(*.env)"] }).behavior).toBe(
      "deny",
    );
  });

  it("cannot reach anchored rules", () => {
    const deny = ["Read(~/notes/**)", "Read(!~/notes/public/**)"];
    expect(read([`${HOME}/notes/public/a.md`], { deny }).behavior).toBe("deny");
  });

  it("cannot reopen a file inside a directory blocked as a whole", () => {
    const deny = ["Read(secrets/**)", "Read(!secrets/public/**)"];
    expect(read([`${P}/secrets/public/a`], { deny }).behavior).toBe("deny");
  });
});

describe("case", () => {
  it("matches deny and ask rules without regard to case", () => {
    expect(blocksRead("Read(.env)", `${P}/.ENV`)).toBe(true);
    expect(blocksEdit("Edit(/Secrets/**)", `${P}/secrets/x`)).toBe(true);
    expect(read([`${P}/.ENV`], { ask: ["Read(.env)"] }).behavior).toBe("ask");
  });

  it("matches allow rules exactly", () => {
    expect(allowsEdit("Edit(/src/**)", `${P}/SRC/x.ts`)).toBe(false);
  });
});

describe("rule families", () => {
  it("applies Read deny rules to edits as well", () => {
    expect(blocksEdit("Read(.env)", `${P}/.env`)).toBe(true);
  });

  it("does not apply Edit deny rules to reads", () => {
    expect(blocksRead("Edit(.env)", `${P}/.env`)).toBe(false);
  });

  it("applies Write and Grep path deny rules as Edit and Read rules", () => {
    expect(blocksEdit("Write(docs/**)", `${P}/docs/a.md`)).toBe(true);
    expect(blocksRead("Grep(docs/**)", `${P}/docs/a.md`)).toBe(true);
    expect(allowsEdit("Write(docs/**)", `${P}/docs/a.md`)).toBe(false);
  });

  it("applies path rules to every tool with that kind of subject", () => {
    const deny = ["Read(.env)"];
    for (const toolName of ["Grep", "Glob", "SomeFutureReader"]) {
      expect(run(toolName, { kind: "read", paths: [`${P}/.env`] }, { deny }).behavior).toBe("deny");
    }
    const editDeny = ["Edit(locked/**)"];
    for (const toolName of ["Write", "NotebookEdit"]) {
      expect(
        run(toolName, { kind: "edit", paths: [`${P}/locked/a`] }, { deny: editDeny }).behavior,
      ).toBe("deny");
    }
  });
});
