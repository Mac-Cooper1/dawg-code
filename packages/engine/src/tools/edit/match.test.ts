import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FileText, type MatchPlan, type MatchStep, type Preprocess, planEdit } from "./match.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

const NBSP = String.fromCharCode(0xa0);
const ZWSP = String.fromCharCode(0x200b);

function plan(file: string, oldString: string, newString: string, replaceAll = false): MatchPlan {
  return planEdit(new FileText(file), oldString, newString, replaceAll);
}

function lines(...parts: string[]): string {
  return parts.join("\n");
}

interface Case {
  name: string;
  file: string;
  old: string;
  new: string;
  replaceAll?: boolean;
  expected: string;
  step: MatchStep;
  preprocess?: Preprocess;
}

const TAB_FILE = lines("function f() {", "\tif (x) {", "\t\treturn 1;", "\t}", "}", "");

const cases: Case[] = [
  {
    name: "exact unique match",
    file: lines("a", "b", "c", ""),
    old: "b",
    new: "B",
    expected: lines("a", "B", "c", ""),
    step: "exact",
  },
  {
    name: "spaces in old_string, tabs in the file",
    file: TAB_FILE,
    old: lines("    if (x) {", "        return 1;", "    }"),
    new: lines("    if (x) {", "        return 2;", "    }"),
    expected: lines("function f() {", "\tif (x) {", "\t\treturn 2;", "\t}", "}", ""),
    step: "indentation",
  },
  {
    name: "a new line written with spaces is re-indented with tabs",
    file: TAB_FILE,
    old: lines("    if (x) {", "        return 1;", "    }"),
    new: lines("    if (x) {", "        log(x);", "        return 1;", "    }"),
    expected: lines("function f() {", "\tif (x) {", "\t\tlog(x);", "\t\treturn 1;", "\t}", "}", ""),
    step: "indentation",
  },
  {
    name: "old_string without the block's common indentation",
    file: lines("class A:", "    def f(self):", "        x = 1", "        return x", ""),
    old: lines("x = 1", "return x"),
    new: lines("x = 2", "return x"),
    expected: lines("class A:", "    def f(self):", "        x = 2", "        return x", ""),
    step: "indentation",
  },
  {
    name: "replacement that changes indentation depth (wrapping in a block)",
    file: lines("def f():", "    x = 1", "    return x", ""),
    old: lines("x = 1", "return x"),
    new: lines("try:", "    x = 1", "except E:", "    x = 2", "return x"),
    expected: lines(
      "def f():",
      "    try:",
      "        x = 1",
      "    except E:",
      "        x = 2",
      "    return x",
      "",
    ),
    step: "indentation",
  },
  {
    name: "two-space old_string in a four-space file",
    file: lines("if a:", "    if b:", "        go()", ""),
    old: lines("if b:", "  go()"),
    new: lines("if b:", "  go()", "  stop()"),
    expected: lines("if a:", "    if b:", "        go()", "        stop()", ""),
    step: "indentation",
  },
  {
    name: "mixed indentation: tab then alignment spaces, kept on unchanged lines",
    file: lines("\tfont: `Iosevka,", "\t\t  Menlo,  ", "\t\t\tmonospace`,", ""),
    old: lines("    font: `Iosevka,", "          Menlo,", "            monospace`,"),
    new: lines("    font: `Iosevka,", "          Menlo, Monaco,", "            monospace`,"),
    expected: lines("\tfont: `Iosevka,", "\t\t  Menlo, Monaco,  ", "\t\t\tmonospace`,", ""),
    step: "indentation",
  },
  {
    name: "first line matched part-way through a line",
    file: lines("\treturn foo(a,", "\t\tb);", ""),
    old: lines("foo(a,", "    b);"),
    new: lines("foo(a,", "    c);"),
    expected: lines("\treturn foo(a,", "\t\tc);", ""),
    step: "indentation",
  },
  {
    name: "CRLF file, LF old_string",
    file: "a\r\nb\r\nc\r\n",
    old: "a\nb",
    new: "a\nB\nb2",
    expected: "a\r\nB\r\nb2\r\nc\r\n",
    step: "line-endings",
  },
  {
    name: "CRLF file, exact single-line match, multi-line replacement",
    file: "a\r\nb\r\nc\r\n",
    old: "b",
    new: "b\nb2",
    expected: "a\r\nb\r\nb2\r\nc\r\n",
    step: "exact",
  },
  {
    name: "CRLF file with tabs, old_string with spaces and LF",
    file: "{\r\n\tone();\r\n\ttwo();\r\n}\r\n",
    old: "    one();\n    two();",
    new: "    one();\n    three();",
    expected: "{\r\n\tone();\r\n\tthree();\r\n}\r\n",
    step: "indentation",
  },
  {
    name: "trailing whitespace in the file is kept, also on the changed line",
    file: lines("x = 1   ", "y = 2\t", ""),
    old: lines("x = 1", "y = 2"),
    new: lines("x = 10", "y = 2"),
    expected: lines("x = 10   ", "y = 2\t", ""),
    step: "trailing-whitespace",
  },
  {
    name: "deleting a line between lines with trailing whitespace",
    file: lines('\t"yaml", ', '\t"legacy-xml",\t\t', '\t"toml",  ', "];"),
    old: lines('\t"yaml",', '\t"legacy-xml",', '\t"toml",'),
    new: lines('\t"yaml",', '\t"toml",'),
    expected: lines('\t"yaml", ', '\t"toml",  ', "];"),
    step: "trailing-whitespace",
  },
  {
    name: "curly quotes in the file, straight quotes in old_string",
    file: lines("msg = “hello” + ‘x’", ""),
    old: `msg = "hello" + 'x'`,
    new: `msg = "hello there" + 'x'`,
    expected: lines("msg = “hello there” + ‘x’", ""),
    step: "look-alikes",
  },
  {
    name: "curly quotes in old_string, straight quotes in the file",
    file: lines('say "hi"', ""),
    old: "say “hi”",
    new: "say “hello”",
    expected: lines('say "hello"', ""),
    step: "look-alikes",
  },
  {
    name: "non-breaking space in the file",
    file: lines(`a${NBSP}= 1`, ""),
    old: "a = 1",
    new: "a = 2",
    expected: lines(`a${NBSP}= 2`, ""),
    step: "look-alikes",
  },
  {
    name: "em dash in the file, hyphen in old_string",
    file: lines("// see — here", "code();", ""),
    old: lines("// see - here", "code();"),
    new: lines("// look - here", "code();"),
    expected: lines("// look — here", "code();", ""),
    step: "look-alikes",
  },
  {
    name: "zero-width space in the file",
    file: lines(`const id${ZWSP} = 1;`, ""),
    old: "const id = 1;",
    new: "const id = 2;",
    expected: lines(`const id${ZWSP} = 2;`, ""),
    step: "look-alikes",
  },
  {
    name: "alignment spaces collapsed in old_string",
    file: lines("\ttimeoutMs:      1500,  ", "\tretries:        3,\t", ""),
    old: "timeoutMs: 1500,",
    new: "timeoutMs: 2500,",
    expected: lines("\ttimeoutMs:      2500,  ", "\tretries:        3,\t", ""),
    step: "inner-whitespace",
  },
  {
    name: "match at the very start of the file",
    file: lines("first", "second", ""),
    old: "first\n",
    new: "1st\n",
    expected: lines("1st", "second", ""),
    step: "exact",
  },
  {
    name: "match at the end of a file with no final newline",
    file: lines("a", "last"),
    old: "last",
    new: "LAST",
    expected: lines("a", "LAST"),
    step: "exact",
  },
  {
    name: "old_string ends with a newline the file does not have",
    file: lines("a", "last"),
    old: lines("a", "last", ""),
    new: lines("a", "LAST", ""),
    expected: lines("a", "LAST"),
    step: "line-endings",
  },
  {
    name: "missing final newline and an added line at the end",
    file: lines("a", "last"),
    old: lines("last", ""),
    new: lines("last", "after", ""),
    expected: lines("a", "last", "after"),
    step: "line-endings",
  },
  {
    name: "unicode: accents, CJK and astral characters",
    file: lines("naïve = '日本語'", "emoji = '🎉'", ""),
    old: "emoji = '🎉'",
    new: "emoji = '🚀'",
    expected: lines("naïve = '日本語'", "emoji = '🚀'", ""),
    step: "exact",
  },
  {
    name: "replace_all with exact matches",
    file: lines("foo(1);", "bar();", "foo(1);", ""),
    old: "foo(1)",
    new: "foo(2)",
    replaceAll: true,
    expected: lines("foo(2);", "bar();", "foo(2);", ""),
    step: "exact",
  },
  {
    name: "replace_all with tolerant (indentation) matches",
    file: lines("\tfoo(1);", "\tbar();", "\t\tfoo(1);", ""),
    old: "    foo(1);",
    new: "    foo(2);",
    replaceAll: true,
    expected: lines("\tfoo(2);", "\tbar();", "\t\tfoo(2);", ""),
    step: "indentation",
  },
  {
    name: "replace_all takes overlapping matches left to right",
    file: lines("aaa", ""),
    old: "aa",
    new: "b",
    replaceAll: true,
    expected: lines("ba", ""),
    step: "exact",
  },
  {
    name: "line-number prefixes copied from Read output",
    file: lines("a", "b", "c", ""),
    old: lines("2→b", "3→c"),
    new: lines("2→B", "3→c"),
    expected: lines("a", "B", "c", ""),
    step: "exact",
    preprocess: "line-numbers",
  },
  {
    name: "line-number prefixes pick the right one of two identical blocks",
    file: lines("x", "y", "x", "y", ""),
    old: lines("  3→x", "  4→y"),
    new: lines("  3→X", "  4→y"),
    expected: lines("x", "y", "X", "y", ""),
    step: "exact",
    preprocess: "line-numbers",
  },
  {
    name: "cat -n style prefixes with a tab, on a tab-indented file",
    file: lines("{", "\tone();", "\ttwo();", "}", ""),
    old: lines("     2\t\tone();", "     3\t\ttwo();"),
    new: lines("     2\t\tone();", "     3\t\tthree();"),
    expected: lines("{", "\tone();", "\tthree();", "}", ""),
    step: "exact",
    preprocess: "line-numbers",
  },
  {
    name: "literal \\n escapes instead of line breaks",
    file: lines("a", "b", ""),
    old: "a\\nb",
    new: "a\\nB",
    expected: lines("a", "B", ""),
    step: "exact",
    preprocess: "escapes",
  },
];

describe("edit matching table", () => {
  it.each(cases)("$name", (c) => {
    const result = plan(c.file, c.old, c.new, c.replaceAll ?? false);
    expect(result.kind).toBe("matched");
    if (result.kind !== "matched") return;
    expect(result.newText).toBe(c.expected);
    expect(result.step).toBe(c.step);
    expect(result.preprocess).toBe(c.preprocess ?? "none");
  });
});

describe("ambiguous and missing matches", () => {
  it("reports every line of a repeated block", () => {
    const file = lines(
      "start",
      "if (x) {",
      "  go();",
      "}",
      "middle",
      "if (x) {",
      "  go();",
      "}",
      "",
    );
    const result = plan(file, lines("if (x) {", "  go();", "}"), "removed");
    expect(result).toEqual({ kind: "ambiguous", step: "exact", preprocess: "none", lines: [2, 6] });
  });

  it("is unique once a neighbouring line is included", () => {
    const file = lines(
      "start",
      "if (x) {",
      "  go();",
      "}",
      "middle",
      "if (x) {",
      "  go();",
      "}",
      "",
    );
    const result = plan(
      file,
      lines("middle", "if (x) {", "  go();"),
      lines("middle", "if (y) {", "  go();"),
    );
    expect(result.kind).toBe("matched");
    if (result.kind === "matched") {
      expect(result.newText).toBe(
        lines("start", "if (x) {", "  go();", "}", "middle", "if (y) {", "  go();", "}", ""),
      );
    }
  });

  it("counts overlapping candidates as separate matches", () => {
    expect(plan(lines("aaa", ""), "aa", "b")).toMatchObject({ kind: "ambiguous", lines: [1, 1] });
    expect(plan(lines("}", "}", "}", ""), lines("}", "}"), "]")).toMatchObject({
      kind: "ambiguous",
      lines: [1, 2],
    });
  });

  it("is ambiguous when a tolerant step finds several places", () => {
    const file = lines("\tfoo(1);", "\tbar();", "\t\tfoo(1);", "");
    expect(plan(file, "    foo(1);", "    foo(2);")).toMatchObject({
      kind: "ambiguous",
      step: "indentation",
      lines: [1, 3],
    });
  });

  it("stops at the first step that finds anything", () => {
    // Exact finds one place; the indentation step would also find the tab-indented one.
    const file = lines("    foo();", "\tfoo();", "");
    const result = plan(file, "    foo();", "    bar();");
    expect(result).toMatchObject({ kind: "matched", step: "exact" });
    if (result.kind === "matched") expect(result.newText).toBe(lines("    bar();", "\tfoo();", ""));
  });

  it("gives new_string the file's line endings", () => {
    expect(plan("a\nb\n", "a", "x\r\ny")).toMatchObject({ newText: "x\ny\nb\n" });
    expect(plan("a\r\nb\r\n", "a", "x\ny")).toMatchObject({ newText: "x\r\ny\r\nb\r\n" });
    // old_string used CRLF itself and matched exactly: new_string is taken as written.
    expect(plan("a\r\nb\nc\n", "a\r\nb", "x\r\ny")).toMatchObject({ newText: "x\r\ny\nc\n" });
  });

  it("replaces every one of many matches with replace_all", () => {
    const file = "x;".repeat(5000);
    const result = plan(file, "x", "y", true);
    expect(result).toMatchObject({ kind: "matched", newText: "y;".repeat(5000) });
  });

  it("finds nothing for text that is not there", () => {
    expect(plan(lines("a", "b", ""), "c", "d")).toEqual({ kind: "none" });
  });

  it("does not let whitespace-only old_string match loosely", () => {
    expect(plan(lines("a", "  ", "b", ""), "\t", "x")).toEqual({ kind: "none" });
  });

  it("does not treat ordinary numbered text as line-number prefixes", () => {
    // "1\tone" lines are real data; only a run counting up by one is taken as prefixes.
    const file = lines("1\tone", "3\tthree", "");
    expect(plan(file, lines("1\tone", "3\tthree"), lines("1\tuno", "3\tthree"))).toMatchObject({
      kind: "matched",
      step: "exact",
      preprocess: "none",
    });
  });
});

describe("tolerance notes", () => {
  it("reports trailing whitespace and indentation differences", () => {
    const result = plan(
      lines("\tx = 1  ", "\ty = 2", ""),
      lines("    x = 1", "    y = 2"),
      lines("    x = 3", "    y = 2"),
    );
    expect(result.kind).toBe("matched");
    if (result.kind !== "matched") return;
    expect(result.differences).toMatchObject({
      indentation: true,
      trailingWhitespace: true,
      indentationConsistent: true,
      fileIndent: { kind: "tab", unit: 1 },
      modelIndent: { kind: "space", unit: 4 },
    });
  });

  it("lists the look-alike characters the file has", () => {
    const result = plan(lines("it’s “fine”", ""), `it's "fine"`, `it's "good"`);
    if (result.kind !== "matched") throw new Error("expected a match");
    expect(result.differences.lookAlikes).toEqual(["’", "“", "”"]);
    expect(result.newText).toBe(lines("it’s “good”", ""));
  });

  it("flags a missing final newline", () => {
    const result = plan("x\ny", "x\ny\n", "x\nz\n");
    if (result.kind !== "matched") throw new Error("expected a match");
    expect(result.differences.missingFinalNewline).toBe(true);
    expect(result.newText).toBe("x\nz");
  });
});

describe("eval fixtures", () => {
  it("edit-with-awkward-whitespace: sloppy edits produce the expected bytes", () => {
    const task = path.join(REPO, "evals/tasks/edit-with-awkward-whitespace");
    let text = readFileSync(path.join(task, "fixture/src/settings.js"), "utf8");
    const expected = readFileSync(path.join(task, "check/expected_settings.js"), "utf8");
    // The kinds of old_string a local model writes for this task: alignment spaces collapsed,
    // trailing whitespace dropped, tabs written as spaces.
    const edits: Array<[string, string]> = [
      ["timeoutMs: 1500,", "timeoutMs: 2500,"],
      ['    "yaml",\n    "legacy-xml",\n    "toml",', '    "yaml",\n    "toml",'],
      ['    colour: "#1e1e1e",', '    color: "#1e1e1e",'],
      ["const bg = theme.colour;", "const bg = theme.color;"],
    ];
    for (const [oldString, newString] of edits) {
      const result = plan(text, oldString, newString);
      expect(result.kind, oldString).toBe("matched");
      if (result.kind === "matched") text = result.newText;
    }
    expect(text).toBe(expected);
  });

  it("change-deep-in-long-file: a repeated line is ambiguous, a re-indented block is not", () => {
    const task = path.join(REPO, "evals/tasks/change-deep-in-long-file");
    const text = readFileSync(path.join(task, "fixture/cardgame/cards.py"), "utf8");
    const expected = readFileSync(path.join(task, "solution/cardgame/cards.py"), "utf8");
    const repeated = plan(text, "for opponent in state.opponents(player):", "x");
    expect(repeated.kind).toBe("ambiguous");
    if (repeated.kind === "ambiguous") expect(repeated.lines.length).toBe(46);

    // Written with two-space indentation and without the method's own indentation.
    const result = plan(
      text,
      lines(
        "for opponent in state.opponents(player):",
        "  taken = state.damage(opponent, self.drain)",
        "state.heal(player, taken)",
      ),
      lines(
        "total = 0",
        "for opponent in state.opponents(player):",
        "  total += state.damage(opponent, self.drain)",
        "state.heal(player, total)",
      ),
    );
    expect(result).toMatchObject({ kind: "matched", step: "indentation" });
    if (result.kind === "matched") expect(result.newText).toBe(expected);
  });
});
