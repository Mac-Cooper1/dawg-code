// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell command lines, not templates
import { describe, expect, it } from "vitest";
import { parseShell, staticValue } from "./parse.ts";

/** The simple commands found, as their words' raw text. */
function commands(src: string): string[] {
  const r = parseShell(src);
  return r.commands.map((c) => [...c.assignments, ...c.words].map((w) => w.raw).join(" "));
}

function ok(src: string): string[] {
  const r = parseShell(src);
  expect(r.error, `parse error for ${JSON.stringify(src)}`).toBeNull();
  return commands(src);
}

function fails(src: string): string {
  const r = parseShell(src);
  expect(r.error, `expected an error for ${JSON.stringify(src)}`).not.toBeNull();
  return r.error as string;
}

describe("splitting", () => {
  it.each([
    ["a && b", ["a", "b"]],
    ["a || b", ["a", "b"]],
    ["a; b", ["a", "b"]],
    ["a | b", ["a", "b"]],
    ["a |& b", ["a", "b"]],
    ["a & b", ["a", "b"]],
    ["a &", ["a"]],
    ["a\nb", ["a", "b"]],
    ["a;b;c", ["a", "b", "c"]],
    ["! a | b", ["a", "b"]],
    ["time -p a", ["a"]],
  ])("%j", (src, expected) => {
    expect(ok(src)).toEqual(expected);
  });

  it("does not split operators inside quotes or escapes", () => {
    expect(ok(`echo "a && b; c | d" 'e || f & g' a\\;b`)).toEqual([
      `echo "a && b; c | d" 'e || f & g' a\\;b`,
    ]);
    const words = parseShell(`echo a\\;b`).commands[0]?.words ?? [];
    expect(words.map(staticValue)).toEqual(["echo", "a;b"]);
  });

  it("joins line continuations, inside words too", () => {
    expect(ok("git sta\\\ntus \\\n&& r\\\nm -rf x")).toEqual(["git status", "rm -rf x"]);
  });

  it("ends a comment at the line break, even after a backslash", () => {
    expect(ok("ls # hidden; rm -rf / \\\nrm -rf x")).toEqual(["ls", "rm -rf x"]);
    expect(ok("echo a#b")).toEqual(["echo a#b"]);
    expect(ok("echo $#")).toEqual(["echo $#"]);
  });
});

describe("quoting", () => {
  it("decodes ANSI-C quotes", () => {
    const w = parseShell("$'\\x72\\x6d' $'a\\'b' $'\\n'").commands[0]?.words ?? [];
    expect(w.map(staticValue)).toEqual(["rm", "a'b", "\n"]);
  });

  it('treats double quotes like the shell: expansions inside, escapes only before $ ` " \\', () => {
    const w = parseShell(`echo "a\\$b" "c\\d" "$x"`).commands[0]?.words ?? [];
    expect(w.map(staticValue)).toEqual(["echo", "a$b", "c\\d", null]);
  });

  it("reports unterminated quotes", () => {
    fails(`echo "abc`);
    fails(`echo 'abc`);
    fails(`echo $'abc`);
    fails("echo `abc");
  });
});

describe("substitutions", () => {
  it("finds commands in $(), nested", () => {
    expect(ok("echo $(a $(b $(c)))")).toEqual([
      "c",
      "b $(c)",
      "a $(b $(c))",
      "echo $(a $(b $(c)))",
    ]);
  });

  it("finds commands in backticks, nested with escapes", () => {
    expect(ok("echo `a \\`b\\``")).toEqual(["b", "a `b`", "echo `a \\`b\\``"]);
  });

  it("finds commands in substitutions inside double quotes and parameter defaults", () => {
    expect(ok(`echo "x$(a)y" \${v:-$(b)}`)).toEqual(["a", "b", `echo "x$(a)y" \${v:-$(b)}`]);
  });

  it("finds commands in process substitutions", () => {
    expect(ok("diff <(a) >(b)")).toEqual(["a", "b", "diff <(a) >(b)"]);
  });

  it("finds commands in arithmetic", () => {
    expect(ok("echo $(( $(a) + 1 ))")).toContain("a");
  });

  it("records where a command sits", () => {
    const r = parseShell("(a; { b; }) && echo $(c)");
    expect(r.commands.map((c) => c.nesting)).toEqual([
      ["subshell"],
      ["subshell", "brace group"],
      ["command substitution"],
      [],
    ]);
  });

  it("refuses constructs it cannot follow", () => {
    expect(fails("echo ${x@P}")).toMatch(/prompt expansion/);
    expect(fails("echo ${(e)x}")).toMatch(/flags/);
    expect(fails("ls @(a|b)")).toMatch(/extended glob/);
    expect(fails("ls !(a)")).toMatch(/extended glob/);
    expect(fails("(( x = 1 ))")).toMatch(/arithmetic/);
    expect(fails("for ((i=0;i<3;i++)); do a; done")).toMatch(/arithmetic/);
    expect(fails("f() { rm -rf /; }; f")).toMatch(/function/);
    expect(fails("function f { a; }")).toMatch(/function/);
    expect(fails("coproc a")).toMatch(/coprocess/);
  });
});

describe("here-documents", () => {
  it("does not read the body as commands", () => {
    expect(ok("cat <<EOF\nrm -rf /\nEOF\necho done")).toEqual(["cat", "echo done"]);
    expect(ok("cat <<'EOF'\n$(rm -rf /)\nEOF")).toEqual(["cat"]);
    expect(ok('cat <<"EOF"\n`rm -rf /`\nEOF')).toEqual(["cat"]);
  });

  it("finds substitutions in an unquoted body, which the shell runs", () => {
    expect(ok("cat <<EOF\n$(rm -rf /)\n`id`\nEOF")).toEqual(["cat", "rm -rf /", "id"]);
  });

  it("supports <<- and several documents on one line", () => {
    expect(ok("cat <<-A <<B\n\tx\n\tA\ny\nB\nls")).toEqual(["cat", "ls"]);
  });

  it("keeps the body", () => {
    const r = parseShell("cat <<EOF > out\nhello\nEOF");
    const redirects = r.commands[0]?.redirects ?? [];
    expect(redirects.map((x) => x.op)).toEqual(["<<", ">"]);
    expect(redirects[0]?.heredoc?.body).toBe("hello\n");
  });

  it("refuses a document that is never closed", () => {
    fails("cat <<EOF\nno end");
    fails("cat <<EOF");
  });

  it("reads here-strings as words, not files", () => {
    const r = parseShell("grep x <<< $(a)");
    expect(r.error).toBeNull();
    expect(r.commands.map((c) => c.words[0]?.raw)).toEqual(["a", "grep"]);
  });
});

describe("compound commands", () => {
  it("handles if, loops, case and brace groups", () => {
    expect(ok("if a; then b; elif c; then d; else e; fi")).toEqual(["a", "b", "c", "d", "e"]);
    expect(ok("while a; do b; done; until c; do d; done")).toEqual(["a", "b", "c", "d"]);
    expect(ok('for f in *.ts $(g); do wc -l "$f"; done')).toEqual(["g", 'wc -l "$f"']);
    expect(ok("case $x in a|b) c;; (d) e;& *) f;;& esac")).toEqual(["c", "e", "f"]);
    expect(ok("{ a; b; } > out")).toEqual(["a", "b"]);
  });

  it("attaches a compound command's redirections to every command inside", () => {
    const r = parseShell("{ a; b; } > out 2>&1");
    for (const c of r.commands) expect(c.redirects.map((x) => x.op)).toEqual([">", ">&"]);
  });

  it("does not split [[ ]] on its operators", () => {
    expect(ok("[[ -f a && $b < c || d =~ ^(x|y)$ ]] && e")).toEqual([
      "[[ -f a && $b < c || d =~ ^(x|y)$ ]]",
      "e",
    ]);
  });

  it("records loop variables", () => {
    expect(parseShell("for PATH in /tmp; do ls; done").loopVariables).toEqual(["PATH"]);
  });
});

describe("words and redirections", () => {
  it("separates assignments from the command", () => {
    const c = parseShell("A=1 B=$(x) C=(1 2) cmd A=2").commands.at(-1);
    expect(c?.assignments.map((w) => w.raw)).toEqual(["A=1", "B=$(x)", "C="]);
    expect(c?.words.map((w) => w.raw)).toEqual(["cmd", "A=2"]);
  });

  it("reads redirections with descriptors", () => {
    const c = parseShell("a 2>&1 >out &>both {fd}>x <in 3<>rw >|clob").commands[0];
    expect(c?.redirects.map((r) => `${r.fd ?? ""}${r.op}${r.target?.raw ?? ""}`)).toEqual([
      "2>&1",
      ">out",
      "&>both",
      "{fd}>x",
      "<in",
      "3<>rw",
      ">|clob",
    ]);
  });
});

describe("errors", () => {
  it.each([
    "a &&",
    "a ||",
    "a |",
    "; a",
    "a ;;",
    "&& a",
    "a )",
    "( a",
    "{ a",
    "if a; then b",
    "echo foo\\",
    "a > ",
  ])("%j is reported, not guessed", (src) => {
    fails(src);
  });

  it("survives deep nesting without throwing", () => {
    const deep = `${"$(".repeat(500)}a${")".repeat(500)}`;
    expect(() => parseShell(deep)).not.toThrow();
    expect(parseShell(deep).error).not.toBeNull();
  });
});
