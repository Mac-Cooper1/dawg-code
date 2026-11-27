/**
 * The sandbox on the command line (Phase 4): `--sandbox` turns it on, a blocked command gets a
 * line of its own even without --verbose, and permission requests say when a command would run
 * outside it. The end-to-end case runs the real sandbox, so macOS only.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { text, toolCall } from "@dawg/mock-model";
import type { PermissionRequest, ToolDisplay } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./__fixtures__/harness.ts";
import { parseArgs } from "./args.ts";
import { settingsFlagsFrom } from "./engine.ts";
import { EXIT } from "./exit-codes.ts";
import { permissionLines, sandboxLine } from "./render.ts";

const onMac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

let h: Harness | null = null;
const folders: string[] = [];
afterEach(async () => {
  await h?.close();
  h = null;
  await Promise.all(folders.splice(0).map((f) => rm(f, { recursive: true, force: true })));
});

const command: ToolDisplay = {
  kind: "command",
  command: "touch /etc/x",
  cwd: "/p",
  exitCode: 1,
  durationMs: 10,
  timedOut: false,
  interrupted: false,
  backgroundTaskId: null,
  outputPath: null,
  output: "",
  notes: [],
};

describe("--sandbox", () => {
  it("turns the sandbox on through the settings flags", () => {
    const parsed = parseArgs(["-p", "hi", "--sandbox"]);
    expect(parsed).toMatchObject({ kind: "options", options: { sandbox: true } });
    if (parsed.kind !== "options") throw new Error("not parsed");
    expect(settingsFlagsFrom(parsed.options)).toEqual({ sandbox: true });
    const off = parseArgs(["-p", "hi"]);
    if (off.kind !== "options") throw new Error("not parsed");
    expect(settingsFlagsFrom(off.options)).toEqual({});
    expect(parseArgs(["compat", "--sandbox"])).toMatchObject({ kind: "error" });
  });

  it("is in the help", async () => {
    const { HELP } = await import("./args.ts");
    expect(HELP).toContain("--sandbox");
  });
});

describe("sandbox lines", () => {
  it("says what the sandbox blocked, and nothing otherwise", () => {
    expect(sandboxLine(command)).toBeNull();
    expect(
      sandboxLine({ ...command, sandbox: { placement: "inside", reason: null, blocked: [] } }),
    ).toBeNull();
    expect(
      sandboxLine({
        ...command,
        sandbox: {
          placement: "inside",
          reason: null,
          blocked: ["Writing /etc/x", "Connecting to example.com:443 (not on the allowed list)"],
        },
      }),
    ).toBe(
      "  Blocked by the sandbox: Writing /etc/x; Connecting to example.com:443 (not on the allowed list)",
    );
  });

  it("says when a permission request is for a command outside the sandbox", () => {
    const request: PermissionRequest = {
      requestId: "r",
      toolCallId: "c",
      toolName: "Bash",
      input: { command: "curl https://example.com", dangerouslyDisableSandbox: true },
      title: "Run a shell command outside the sandbox",
      reason: "No rule allows this command.",
      suggestions: [],
      sandbox: { placement: "outside", reason: "retry", blocked: [] },
    };
    const lines = permissionLines(request, "/p");
    expect(lines[0]).toBe("Permission needed: Run a shell command outside the sandbox");
    expect(lines).toContain(
      "  Runs outside the sandbox: the sandbox blocked it, and it is being tried again without it.",
    );
    expect(
      permissionLines(
        { ...request, sandbox: { placement: "inside", reason: null, blocked: [] } },
        "/p",
      ).some((l) => l.includes("outside the sandbox:")),
    ).toBe(false);
  });
});

describe.skipIf(!onMac)("dawg -p --sandbox", () => {
  it("blocks a write outside the project, says so on stderr, and leaves no temp folder", async () => {
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), "dawg-cli-outside-")));
    folders.push(outside);
    const escaped = path.join(outside, "outside.txt");
    h = await startHarness({
      script: [toolCall("Bash", { command: `echo hi > '${escaped}'` }), text("tried")],
    });
    // Bypass mode: no one is asked, so only the sandbox stands between the command and the disk.
    const result = await h.run([
      "-p",
      "write outside",
      "--sandbox",
      "--permission-mode",
      "bypassPermissions",
      "--endpoint",
      h.mock.baseUrl,
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toBe("tried\n");
    expect(existsSync(escaped)).toBe(false);
    // Named from the system's sandbox log, or from the command's own error when the log is slow.
    const line = result.stderr.split("\n").find((l) => l.startsWith("Blocked by the sandbox:"));
    expect(line).toMatch(/^Blocked by the sandbox: (Writing|Not permitted:) /);
    expect(line).toContain(escaped);
    const left = (await readdir(h.root)).filter((name) => name.startsWith("dawg-sandbox-"));
    expect(left).toEqual([]);
  });
});
