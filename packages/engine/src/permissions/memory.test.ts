/**
 * The session's memory folders (`PermissionState.memoryDirectories`): the file tools keep them
 * without asking, through the permission engine, and nothing else changes.
 */
import type { PermissionMode } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import type { PermissionState, PermissionSubject } from "../contracts/permissions.ts";
import {
  emptyFs,
  fakeFs,
  HOME,
  makeState,
  PROJECT,
  type StateInput,
} from "./__fixtures__/helpers.ts";
import { decidePermission } from "./decide.ts";
import type { FsProbe } from "./paths.ts";

const MEMORY = `${HOME}/.dawg/projects/-work-project/memory`;

function decide(
  toolName: string,
  subject: PermissionSubject,
  input: StateInput & { memory?: string[] } = {},
  fs: FsProbe = emptyFs,
) {
  const state: PermissionState = {
    ...makeState(input),
    memoryDirectories: input.memory ?? [MEMORY],
  };
  return decidePermission({ toolName, subject }, state, { fs });
}

const edit = (paths: string[], input: StateInput & { memory?: string[] } = {}, fs?: FsProbe) =>
  decide("Edit", { kind: "edit", paths }, input, fs);
const read = (paths: string[], input: StateInput & { memory?: string[] } = {}) =>
  decide("Read", { kind: "read", paths }, input);

describe("memory folders", () => {
  it("lets the file tools change files there without asking, though ~/.dawg is protected", () => {
    expect(edit([`${MEMORY}/MEMORY.md`]).behavior).toBe("allow");
    expect(edit([`${MEMORY}/notes/testing.md`]).behavior).toBe("allow");
    // Without it, the same file asks: it is outside the project and under .dawg.
    expect(edit([`${MEMORY}/MEMORY.md`], { memory: [] }).behavior).toBe("ask");
  });

  it.each<[PermissionMode, string]>([
    ["default", "allow"],
    ["acceptEdits", "allow"],
    ["dontAsk", "allow"],
    ["bypassPermissions", "allow"],
    ["plan", "deny"],
  ])("in %s mode an edit there is %s", (mode, expected) => {
    expect(edit([`${MEMORY}/MEMORY.md`], { mode }).behavior).toBe(expected);
  });

  it("reads there, and searches the folder itself, without asking", () => {
    expect(read([`${MEMORY}/MEMORY.md`]).behavior).toBe("allow");
    expect(read([MEMORY]).behavior).toBe("allow");
    expect(read([MEMORY], { memory: [] }).behavior).toBe("ask");
  });

  it("is only that folder: its parent and its siblings still ask", () => {
    expect(edit([`${HOME}/.dawg/projects/-work-project/project.json`]).behavior).toBe("ask");
    expect(edit([`${HOME}/.dawg/settings.json`]).behavior).toBe("ask");
    expect(edit([`${MEMORY}-other/x.md`]).behavior).toBe("ask");
    // The folder itself is not a file to write.
    expect(edit([MEMORY]).behavior).toBe("ask");
  });

  it("leaves deny and ask rules in force", () => {
    expect(edit([`${MEMORY}/MEMORY.md`], { deny: ["Edit"] }).behavior).toBe("deny");
    expect(edit([`${MEMORY}/MEMORY.md`], { ask: ["Edit(~/.dawg/**)"] }).behavior).toBe("ask");
    expect(read([`${MEMORY}/MEMORY.md`], { deny: ["Read(~/.dawg/**)"] }).behavior).toBe("deny");
  });

  it("still asks for protected names inside it", () => {
    expect(edit([`${MEMORY}/.git/hooks/pre-commit`]).behavior).toBe("ask");
    expect(edit([`${MEMORY}/.dawg/settings.json`]).behavior).toBe("ask");
  });

  it("goes by where a path really leads", () => {
    const fs = fakeFs({
      dirs: [MEMORY, PROJECT],
      links: { [`${MEMORY}/escape.md`]: "/etc/passwd", [`${PROJECT}/mem`]: MEMORY },
    });
    // A link inside the folder that leads out of it is judged where it leads.
    expect(edit([`${MEMORY}/escape.md`], {}, fs).behavior).toBe("ask");
    // A link into the folder is the folder.
    expect(edit([`${PROJECT}/mem/MEMORY.md`], {}, fs).behavior).toBe("allow");
  });

  it("gives shell commands nothing", () => {
    expect(
      decide("Bash", { kind: "command", command: `rm ${MEMORY}/MEMORY.md` }).behavior,
    ).not.toBe("allow");
  });
});
