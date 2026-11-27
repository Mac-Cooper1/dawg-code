import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type CliOptions, parseArgs } from "./args.ts";
import { safeUrl } from "./models.ts";
import { profileIdForModel } from "./profiles.ts";

function options(argv: string[]): CliOptions {
  const parsed = parseArgs(argv);
  if (parsed.kind !== "options") throw new Error(`expected options, got ${JSON.stringify(parsed)}`);
  return parsed.options;
}

function error(argv: string[]): string {
  const parsed = parseArgs(argv);
  if (parsed.kind !== "error") throw new Error(`expected an error, got ${parsed.kind}`);
  return parsed.message;
}

describe("parseArgs", () => {
  it("reads the headless flags", () => {
    const o = options([
      "-p",
      "fix the failing test",
      "--output-format=json",
      "--model",
      "qwen",
      "--endpoint",
      "http://127.0.0.1:8080/v1",
      "--permission-mode",
      "acceptEdits",
      "--max-turns",
      "12",
      "--cwd",
      "/w",
    ]);
    expect(o).toMatchObject({
      command: "run",
      print: true,
      prompt: "fix the failing test",
      outputFormat: "json",
      model: "qwen",
      endpoint: "http://127.0.0.1:8080/v1",
      permissionMode: "acceptEdits",
      maxTurns: 12,
      cwd: "/w",
      continue: false,
      resume: null,
    });
  });

  it("takes several rules after one flag without swallowing the prompt", () => {
    const o = options([
      "-p",
      "--allowedTools",
      "Bash(git log *)",
      "Read,Edit",
      "fix the bug",
      "--disallowed-tools",
      "Bash(rm *)",
    ]);
    expect(o.allowedTools).toEqual(["Bash(git log *)", "Read", "Edit"]);
    expect(o.disallowedTools).toEqual(["Bash(rm *)"]);
    expect(o.prompt).toBe("fix the bug");
    expect(options(["--allowedTools=Bash,Write", "go"]).allowedTools).toEqual(["Bash", "Write"]);
  });

  it("takes several directories after --add-dir, only existing ones", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dawg-args-"));
    try {
      const o = options(["--add-dir", root, tmpdir(), "do it"]);
      expect(o.addDirs).toEqual([root, tmpdir()]);
      expect(o.prompt).toBe("do it");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("understands aliases and the documented short forms", () => {
    expect(options(["-c"]).continue).toBe(true);
    expect(options(["-r", "abc"]).resume).toBe("abc");
    expect(options(["--dangerously-skip-permissions"]).permissionMode).toBe("bypassPermissions");
    expect(options(["--permission-mode", "manual"]).permissionMode).toBe("default");
    expect(parseArgs(["-h"]).kind).toBe("help");
    expect(parseArgs(["--version"]).kind).toBe("version");
    expect(options(["serve", "--endpoint", "http://x/v1"]).command).toBe("serve");
    expect(options(["--", "-p looks like a flag"]).prompt).toBe("-p looks like a flag");
  });

  it("refuses bad usage with a reason", () => {
    expect(error(["--nope"])).toContain("Unknown option --nope");
    expect(error(["-p", "--output-format", "xml"])).toContain("text, json or stream-json");
    expect(error(["--output-format", "json"])).toContain("only applies with -p");
    expect(error(["--max-turns", "0"])).toContain("positive whole number");
    expect(error(["--permission-mode", "yolo"])).toContain("--permission-mode must be one of");
    expect(error(["-c", "--resume", "x"])).toContain("not both");
    expect(error(["--endpoint", "a", "--model-file", "b"])).toContain("not both");
    expect(error(["--context-size", "100"])).toContain("only applies to --model-file");
    expect(error(["--model"])).toContain("--model needs");
    expect(error(["--model", "a", "--model", "b"])).toContain("twice");
    expect(error(["serve", "-p", "hi"])).toContain("dawg serve does not take");
    expect(error(["--permission-mode", "plan", "--dangerously-skip-permissions"])).toContain(
      "conflicts",
    );
  });
});

describe("--effort", () => {
  it("reads a level and leaves the default alone without one", () => {
    expect(options(["-p", "x", "--effort", "low"]).effort).toBe("low");
    expect(options(["-p", "x", "--effort=xhigh"]).effort).toBe("xhigh");
    expect(options(["-p", "x"]).effort).toBeNull();
  });

  it("refuses something that is not a level name", () => {
    expect(error(["-p", "x", "--effort", "very high"])).toContain("--effort");
    expect(error(["-p", "x", "--effort", "--model"])).toContain("--effort");
  });

  it("is refused by dawg serve, whose clients choose the effort", () => {
    expect(error(["serve", "--effort", "low"])).toContain("--effort");
  });
});

describe("helpers", () => {
  it("picks a profile by model family", () => {
    expect(profileIdForModel("Qwen/Qwen3.8-27B")).toBe("qwen3.8");
    expect(profileIdForModel("qwen3.6:35b-a3b")).toBe("qwen3.6");
    expect(profileIdForModel("/models/Laguna-XS-2.1-Q4_K_M.gguf")).toBe("laguna-xs-2.1");
    expect(profileIdForModel("openai/gpt-oss-20b")).toBe("gpt-oss");
    expect(profileIdForModel("minicpm5-1b-q8")).toBe("minicpm5");
    expect(profileIdForModel("qwen3-8b")).toBeNull();
    expect(profileIdForModel("/qwen3.8-models/other")).toBeNull();
  });

  it("shows URLs without credentials", () => {
    expect(safeUrl("https://user:pw@example.com/v1?key=1")).toBe("https://example.com/v1");
    expect(safeUrl("not a url")).toBe("(invalid URL)");
  });
});
