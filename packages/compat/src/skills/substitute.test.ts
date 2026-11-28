// biome-ignore-all lint/suspicious/noTemplateCurlyInString: skill bodies write ${CLAUDE_*} variables literally
import { describe, expect, test } from "vitest";
import {
  type BodySegment,
  expandSkillBody,
  fileReferences,
  parseInjections,
  splitSkillArguments,
  substituteArguments,
  substituteVariables,
} from "./substitute.ts";

const VARS = {
  skillDir: "/home/me/.claude/skills/review",
  projectDir: "/work/proj",
  sessionId: "s-1",
  effort: "high",
};

const sub = (text: string, raw: string, names: string[] = []) =>
  substituteArguments(text, { raw, names });

/** Joins segments with each command shown as ⟨command⟩. */
const show = (segments: readonly BodySegment[]) =>
  segments.map((s) => (s.type === "text" ? s.text : `⟨${s.command}⟩`)).join("");

describe("arguments", () => {
  test("split like a shell line", () => {
    expect(splitSkillArguments(`"hello world" second 'third one' a\\ b`)).toEqual([
      "hello world",
      "second",
      "third one",
      "a b",
    ]);
    expect(splitSkillArguments("")).toEqual([]);
    expect(splitSkillArguments(`"unclosed rest`)).toEqual(["unclosed rest"]);
  });

  test("$ARGUMENTS, $ARGUMENTS[N] and $N count from 0", () => {
    expect(sub("Fix $ARGUMENTS now", "issue 12")).toEqual({ text: "Fix issue 12 now", used: true });
    expect(sub("$ARGUMENTS[1] then $0", "a b").text).toBe("b then a");
    expect(sub("first $0, second $1", `"hello world" x`).text).toBe("first hello world, second x");
  });

  test("a missing indexed argument stays as written; a missing named one is empty", () => {
    expect(sub("$0 and $2", "only")).toEqual({ text: "only and $2", used: true });
    expect(sub("[$issue] [$branch]", "12", ["issue", "branch"]).text).toBe("[12] []");
    expect(sub("$issue_id stays", "12", ["issue"]).text).toBe("$issue_id stays");
  });

  test("a backslash keeps a placeholder literal, and only a placeholder", () => {
    expect(sub("costs \\$1.00 and \\$HOME", "a b").text).toBe("costs $1.00 and \\$HOME");
    expect(sub("$HOME is left alone", "a").text).toBe("$HOME is left alone");
  });

  test("values are inserted as they are", () => {
    expect(sub("say $0", "$1").text).toBe("say $1");
  });

  test("variables, inside inserted values too", () => {
    expect(
      substituteVariables(
        "${CLAUDE_SKILL_DIR}/x ${DAWG_PROJECT_DIR} ${CLAUDE_SESSION_ID} ${CLAUDE_EFFORT} ${CLAUDE_PLUGIN_ROOT}",
        VARS,
      ),
    ).toBe("/home/me/.claude/skills/review/x /work/proj s-1 high ${CLAUDE_PLUGIN_ROOT}");
    const expanded = expandSkillBody("Use $0", { raw: "${CLAUDE_PROJECT_DIR}", names: [] }, VARS);
    expect(show(expanded.segments)).toBe("Use /work/proj");
  });

  test("arguments no placeholder takes are appended", () => {
    expect(expandSkillBody("Do it.", { raw: "now please", names: [] }, VARS).appendix).toBe(
      "ARGUMENTS: now please",
    );
    expect(expandSkillBody("Do $ARGUMENTS.", { raw: "it", names: [] }, VARS).appendix).toBeNull();
    expect(expandSkillBody("Do it.", { raw: "", names: [] }, VARS).appendix).toBeNull();
  });
});

describe("commands in the body", () => {
  test("inline at the start of a line or after a blank; not after other characters", () => {
    const segments = parseInjections(
      "- Diff: !`git diff HEAD`\nKEY=!`date` stays\n!`ls` and !`pwd`.",
    );
    expect(show(segments)).toBe("- Diff: ⟨git diff HEAD⟩\nKEY=!`date` stays\n⟨ls⟩ and ⟨pwd⟩.");
  });

  test("a ```! block is one command; an ordinary fence is left alone", () => {
    const body = [
      "Before",
      "```!",
      "git status",
      "git log -1",
      "```",
      "After",
      "```sh",
      "!`no`",
      "```",
    ].join("\n");
    const segments = parseInjections(body);
    expect(segments.filter((s) => s.type === "command")).toEqual([
      { type: "command", command: "git status\ngit log -1", block: true },
    ]);
    expect(show(segments)).toBe("Before\n⟨git status\ngit log -1⟩\nAfter\n```sh\n!`no`\n```");
  });

  test("arguments go into commands, but an argument never becomes a command", () => {
    const expanded = expandSkillBody(
      "PR: !`gh pr view $0`\nNote: $1",
      { raw: '12 "!`rm -rf x`"', names: [] },
      VARS,
    );
    expect(expanded.segments).toEqual([
      { type: "text", text: "PR: " },
      { type: "command", command: "gh pr view 12", block: false },
      { type: "text", text: "\nNote: !`rm -rf x`" },
    ]);
  });
});

describe("file references", () => {
  test("@paths outside code, without trailing punctuation", () => {
    expect(
      fileReferences(
        "Review @src/app.ts, and @docs/a.md.\nmail me@example.com\n`@not/this`\n```\n@nor/this\n```",
      ),
    ).toEqual(["src/app.ts", "docs/a.md"]);
  });
});
