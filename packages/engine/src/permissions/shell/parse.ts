/**
 * A parser for the bash-like command lines the model writes, built for one job: finding every
 * simple command a line would run, so that each can be judged on its own.
 *
 * It is deliberately strict. Anything it does not understand with confidence (function
 * definitions, arithmetic commands, extended globs, unterminated quotes, prompt expansion...)
 * stops the parse with an error, and the caller treats the whole line as unparseable. It never
 * guesses: a guess that splits a line differently from the real shell is how a second command
 * gets smuggled past the rules.
 */

/** One piece of a word, after quote removal. */
export type WordSegment =
  /** Literal text. `quoted` is true when it came from quotes or a backslash escape. */
  | { kind: "literal"; text: string; quoted: boolean }
  /** Something the shell computes when the command runs. */
  | {
      kind: "expansion";
      type: "parameter" | "command" | "arithmetic" | "process";
      raw: string;
      quoted: boolean;
    };

export interface ShellWord {
  /** The word as written, with line continuations removed. */
  raw: string;
  segments: WordSegment[];
}

export interface ShellRedirect {
  /** `>`, `>>`, `>|`, `<`, `<>`, `&>`, `&>>`, `>&`, `<&`, `<<`, `<<-` or `<<<`. */
  op: string;
  /** An explicit file descriptor, such as `2` in `2>`, or `{name}`. */
  fd: string | null;
  /** The target word. Null for a here-document. */
  target: ShellWord | null;
  /** Set for `<<` and `<<-`. */
  heredoc: { delimiter: string; quoted: boolean; body: string } | null;
}

export interface ParsedCommand {
  /** Leading `NAME=value` words. */
  assignments: ShellWord[];
  /** The command name and its arguments. Empty for an assignment or redirection on its own. */
  words: ShellWord[];
  redirects: ShellRedirect[];
  /** Where the command sits: "command substitution", "subshell", "if", ... outermost first. */
  nesting: string[];
  /** "test" for a `[[ ... ]]` conditional, whose words are not a command line. */
  kind: "simple" | "test";
}

export interface ParseResult {
  /** Every simple command found, in the order the parser met them. */
  commands: ParsedCommand[];
  /** Why the line could not be parsed with confidence, or null. */
  error: string | null;
  /** Variables a `for` or `select` loop assigns. */
  loopVariables: string[];
  /** Constructs the analyser needs to know about. */
  features: Set<ParseFeature>;
}

export type ParseFeature =
  /** `$(( ))` or `$[ ]`. */
  | "arithmetic"
  /** `[[ ... ]]`. */
  | "conditional"
  /** A quoted literal that contains `$(`, a backtick or `${`: inert unless something evaluates it. */
  | "quoted_substitution_text"
  /** An array subscript inside a parameter expansion or assignment. */
  | "subscript";

class ParseError extends Error {}

const MAX_DEPTH = 40;
const MAX_COMMANDS = 1000;

const RESERVED_TERMINATORS = new Set(["}", "fi", "then", "else", "elif", "do", "done", "esac"]);

function isBlank(c: string | undefined): boolean {
  return c === " " || c === "\t";
}

/** Characters that end an unquoted word. */
function isMeta(c: string | undefined): boolean {
  return (
    c === " " ||
    c === "\t" ||
    c === "\n" ||
    c === ";" ||
    c === "&" ||
    c === "|" ||
    c === "<" ||
    c === ">" ||
    c === "(" ||
    c === ")"
  );
}

interface SharedState {
  commands: ParsedCommand[];
  loopVariables: string[];
  features: Set<ParseFeature>;
}

class Parser {
  private readonly src: string;
  private pos = 0;
  private readonly shared: SharedState;
  private readonly nesting: string[];
  private readonly depth: number;
  private pending: { redirect: ShellRedirect; strip: boolean }[] = [];

  constructor(src: string, shared: SharedState, nesting: string[], depth: number) {
    this.src = src;
    this.shared = shared;
    this.nesting = [...nesting];
    this.depth = depth;
    if (depth > MAX_DEPTH) throw new ParseError("nested too deeply to check");
  }

  parseProgram(): void {
    this.parseCompoundList(() => false);
    this.skipLinebreaks();
    if (this.pos < this.src.length) {
      throw new ParseError(`unexpected ${describeChar(this.src[this.pos])}`);
    }
    if (this.pending.length > 0) throw new ParseError("a here-document is never closed");
  }

  /** Parses the inside of `$(...)`, `<(...)` or `(...)` up to its closing parenthesis. */
  parseUntilCloseParen(label: string): void {
    this.nesting.push(label);
    this.parseCompoundList(() => this.peek() === ")");
    this.skipLinebreaks();
    if (this.peek() !== ")") throw new ParseError(`unterminated ${label}`);
    this.pos++;
    this.nesting.pop();
  }

  // -------------------------------------------------------------------------------------------
  // Character helpers
  // -------------------------------------------------------------------------------------------

  private peek(offset = 0): string | undefined {
    return this.src[this.pos + offset];
  }

  private startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  private atEnd(): boolean {
    return this.pos >= this.src.length;
  }

  /** Skips blanks and line continuations. */
  private skipBlanks(): void {
    for (;;) {
      const c = this.peek();
      if (isBlank(c)) {
        this.pos++;
      } else if (c === "\\" && this.peek(1) === "\n") {
        this.pos += 2;
      } else {
        return;
      }
    }
  }

  /** Skips blanks, line continuations and a comment, leaving any newline in place. */
  private skipBlanksAndComments(): void {
    this.skipBlanks();
    if (this.peek() === "#") {
      // A comment runs to the end of the line. A backslash inside it continues nothing.
      while (!this.atEnd() && this.peek() !== "\n") this.pos++;
    }
  }

  private skipLinebreaks(): void {
    for (;;) {
      this.skipBlanksAndComments();
      if (this.peek() === "\n") {
        this.consumeNewline();
      } else {
        return;
      }
    }
  }

  private consumeNewline(): void {
    this.pos++;
    if (this.pending.length > 0) this.readHeredocBodies();
  }

  /**
   * The plain, unquoted word at the current position, if it is followed by a delimiter. Used to
   * recognise reserved words, which only count when written exactly and unquoted.
   */
  private peekReservedWord(): string | null {
    let j = this.pos;
    while (j < this.src.length) {
      const c = this.src[j];
      if (isMeta(c)) break;
      if (c === "'" || c === '"' || c === "\\" || c === "$" || c === "`") return null;
      j++;
    }
    if (j === this.pos) return null;
    return this.src.slice(this.pos, j);
  }

  private consumeReservedWord(word: string): void {
    if (this.peekReservedWord() !== word) throw new ParseError(`expected "${word}"`);
    this.pos += word.length;
  }

  // -------------------------------------------------------------------------------------------
  // Grammar
  // -------------------------------------------------------------------------------------------

  private parseCompoundList(isTerminator: () => boolean): void {
    for (;;) {
      this.skipLinebreaks();
      if (this.atEnd() || isTerminator()) return;
      this.parseAndOr();
      this.skipBlanksAndComments();
      const c = this.peek();
      if (c === ";" && this.peek(1) !== ";" && this.peek(1) !== "&") {
        this.pos++;
      } else if (c === "&" && this.peek(1) !== "&" && this.peek(1) !== ">") {
        this.pos++;
      } else if (c === "\n") {
        this.consumeNewline();
      } else {
        return;
      }
    }
  }

  private parseAndOr(): void {
    this.parsePipeline();
    for (;;) {
      this.skipBlanksAndComments();
      if (this.startsWith("&&") || this.startsWith("||")) {
        const op = this.src.slice(this.pos, this.pos + 2);
        this.pos += 2;
        this.skipLinebreaks();
        if (this.atEnd()) throw new ParseError(`nothing follows "${op}"`);
        this.parsePipeline();
      } else {
        return;
      }
    }
  }

  private parsePipeline(): void {
    this.skipBlanksAndComments();
    if (this.peekReservedWord() === "!") {
      this.pos++;
      this.skipBlanksAndComments();
    }
    if (this.peekReservedWord() === "time") {
      this.pos += 4;
      this.skipBlanksAndComments();
      if (this.peekReservedWord() === "-p") {
        this.pos += 2;
        this.skipBlanksAndComments();
      }
    }
    this.parseCommand();
    for (;;) {
      this.skipBlanksAndComments();
      if (this.startsWith("|&") || (this.peek() === "|" && this.peek(1) !== "|")) {
        this.pos += this.startsWith("|&") ? 2 : 1;
        this.skipLinebreaks();
        if (this.atEnd()) throw new ParseError('nothing follows "|"');
        this.parseCommand();
      } else {
        return;
      }
    }
  }

  private parseCommand(): void {
    if (this.nesting.length + this.depth > MAX_DEPTH) {
      throw new ParseError("nested too deeply to check");
    }
    this.skipBlanksAndComments();
    if (this.startsWith("((")) throw new ParseError("arithmetic commands are not checked");
    if (this.peek() === "(") {
      const start = this.shared.commands.length;
      this.pos++;
      this.parseUntilCloseParen("subshell");
      this.parseTrailingRedirects(start);
      return;
    }
    const word = this.peekReservedWord();
    switch (word) {
      case "{":
        this.parseBraceGroup();
        return;
      case "if":
        this.parseIf();
        return;
      case "while":
      case "until":
        this.parseWhile(word);
        return;
      case "for":
      case "select":
        this.parseFor(word);
        return;
      case "case":
        this.parseCase();
        return;
      case "[[":
        this.parseConditional();
        return;
      case "function":
        throw new ParseError("defines a shell function");
      case "coproc":
        throw new ParseError("coprocesses are not checked");
      default:
        if (word !== null && RESERVED_TERMINATORS.has(word)) {
          throw new ParseError(`unexpected "${word}"`);
        }
        this.parseSimpleCommand();
        return;
    }
  }

  private parseBraceGroup(): void {
    const start = this.shared.commands.length;
    this.pos++;
    this.nesting.push("brace group");
    this.parseCompoundList(() => this.peekReservedWord() === "}");
    this.consumeReservedWord("}");
    this.nesting.pop();
    this.parseTrailingRedirects(start);
  }

  private parseIf(): void {
    const start = this.shared.commands.length;
    this.pos += 2;
    this.nesting.push("if");
    const isThen = () => this.peekReservedWord() === "then";
    const isBranchEnd = () => {
      const w = this.peekReservedWord();
      return w === "elif" || w === "else" || w === "fi";
    };
    this.parseCompoundList(isThen);
    this.consumeReservedWord("then");
    this.parseCompoundList(isBranchEnd);
    for (;;) {
      const w = this.peekReservedWord();
      if (w === "elif") {
        this.pos += 4;
        this.parseCompoundList(isThen);
        this.consumeReservedWord("then");
        this.parseCompoundList(isBranchEnd);
      } else if (w === "else") {
        this.pos += 4;
        this.parseCompoundList(() => this.peekReservedWord() === "fi");
      } else {
        break;
      }
    }
    this.consumeReservedWord("fi");
    this.nesting.pop();
    this.parseTrailingRedirects(start);
  }

  private parseWhile(keyword: string): void {
    const start = this.shared.commands.length;
    this.pos += keyword.length;
    this.nesting.push(keyword);
    this.parseCompoundList(() => this.peekReservedWord() === "do");
    this.consumeReservedWord("do");
    this.parseCompoundList(() => this.peekReservedWord() === "done");
    this.consumeReservedWord("done");
    this.nesting.pop();
    this.parseTrailingRedirects(start);
  }

  private parseFor(keyword: string): void {
    const start = this.shared.commands.length;
    this.pos += keyword.length;
    this.skipBlanks();
    if (this.startsWith("((")) throw new ParseError("arithmetic for loops are not checked");
    const nameWord = this.readWord();
    const name = staticValue(nameWord);
    if (name === null || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new ParseError(`"${keyword}" needs a variable name`);
    }
    this.shared.loopVariables.push(name);
    this.nesting.push(keyword);
    this.skipLinebreaks();
    if (this.peekReservedWord() === "in") {
      this.pos += 2;
      for (;;) {
        this.skipBlanksAndComments();
        const c = this.peek();
        if (c === undefined || c === ";" || c === "\n") break;
        if (isMeta(c)) throw new ParseError(`unexpected ${describeChar(c)} in a "${keyword}" list`);
        this.readWord();
      }
      if (this.peek() === ";") this.pos++;
      this.skipLinebreaks();
    } else if (this.peek() === ";") {
      this.pos++;
      this.skipLinebreaks();
    }
    this.consumeReservedWord("do");
    this.parseCompoundList(() => this.peekReservedWord() === "done");
    this.consumeReservedWord("done");
    this.nesting.pop();
    this.parseTrailingRedirects(start);
  }

  private parseCase(): void {
    const start = this.shared.commands.length;
    this.pos += 4;
    this.skipBlanks();
    this.readWord();
    this.skipLinebreaks();
    this.consumeReservedWord("in");
    this.nesting.push("case");
    for (;;) {
      this.skipLinebreaks();
      if (this.peekReservedWord() === "esac") {
        this.pos += 4;
        break;
      }
      if (this.atEnd()) throw new ParseError('"case" is never closed');
      if (this.peek() === "(") this.pos++;
      for (;;) {
        this.skipBlanks();
        const c = this.peek();
        if (c === undefined || isMeta(c)) throw new ParseError("malformed case pattern");
        this.readWord();
        this.skipBlanks();
        if (this.peek() === "|") {
          this.pos++;
          continue;
        }
        if (this.peek() === ")") {
          this.pos++;
          break;
        }
        throw new ParseError("malformed case pattern");
      }
      this.parseCompoundList(
        () => this.startsWith(";;") || this.startsWith(";&") || this.peekReservedWord() === "esac",
      );
      if (this.startsWith(";;&")) this.pos += 3;
      else if (this.startsWith(";;") || this.startsWith(";&")) this.pos += 2;
    }
    this.nesting.pop();
    this.parseTrailingRedirects(start);
  }

  /** `[[ ... ]]`: operators inside are part of the expression, not separators or redirections. */
  private parseConditional(): void {
    this.pos += 2;
    this.shared.features.add("conditional");
    const words: ShellWord[] = [literalWord("[[")];
    for (;;) {
      this.skipBlanks();
      const c = this.peek();
      if (c === undefined) throw new ParseError('"[[" is never closed');
      if (c === "\n") throw new ParseError('a line break inside "[[" is not checked');
      if (this.peekReservedWord() === "]]") {
        this.pos += 2;
        words.push(literalWord("]]"));
        break;
      }
      if (this.startsWith("&&") || this.startsWith("||")) {
        words.push(literalWord(this.src.slice(this.pos, this.pos + 2)));
        this.pos += 2;
        continue;
      }
      if (c === "(" || c === ")" || c === "<" || c === ">" || c === "!") {
        words.push(literalWord(c));
        this.pos++;
        continue;
      }
      if (isMeta(c)) throw new ParseError(`unexpected ${describeChar(c)} inside "[["`);
      const word = this.readWord();
      words.push(word);
      if (word.raw === "=~") {
        this.skipBlanks();
        words.push(this.readWord({ regex: true }));
      }
    }
    this.pushCommand({ assignments: [], words, redirects: [], kind: "test" });
    this.parseTrailingRedirects(this.shared.commands.length - 1);
  }

  private parseTrailingRedirects(start: number): void {
    const redirects: ShellRedirect[] = [];
    for (;;) {
      this.skipBlanks();
      if (!this.atRedirect()) break;
      redirects.push(this.parseRedirect());
    }
    if (redirects.length === 0) return;
    for (let i = start; i < this.shared.commands.length; i++) {
      this.shared.commands[i]?.redirects.push(...redirects);
    }
  }

  private parseSimpleCommand(): void {
    const assignments: ShellWord[] = [];
    const words: ShellWord[] = [];
    const redirects: ShellRedirect[] = [];
    for (;;) {
      this.skipBlanksAndComments();
      const c = this.peek();
      if (c === undefined || c === "\n" || c === ";" || c === "|" || c === ")") break;
      if (c === "&" && this.peek(1) !== ">") break;
      if (this.atRedirect()) {
        redirects.push(this.parseRedirect());
        continue;
      }
      if (c === "(") {
        if (words.length === 1 && assignments.length === 0) {
          throw new ParseError("defines a shell function");
        }
        throw new ParseError('unexpected "("');
      }
      const word = this.readWord();
      if (words.length === 0 && assignmentName(word) !== null) {
        if (/^[A-Za-z_][A-Za-z0-9_]*\[/.test(word.raw)) this.shared.features.add("subscript");
        if (word.raw.endsWith("=") && this.peek() === "(") this.readArrayLiteral();
        assignments.push(word);
        continue;
      }
      words.push(word);
    }
    if (words.length === 0 && assignments.length === 0 && redirects.length === 0) {
      const c = this.peek();
      throw new ParseError(c === undefined ? "empty command" : `unexpected ${describeChar(c)}`);
    }
    this.pushCommand({ assignments, words, redirects, kind: "simple" });
  }

  private readArrayLiteral(): void {
    this.pos++;
    for (;;) {
      this.skipLinebreaks();
      const c = this.peek();
      if (c === undefined) throw new ParseError("an array is never closed");
      if (c === ")") {
        this.pos++;
        return;
      }
      if (isMeta(c)) throw new ParseError(`unexpected ${describeChar(c)} in an array`);
      this.readWord();
    }
  }

  private pushCommand(command: Omit<ParsedCommand, "nesting">): void {
    if (this.shared.commands.length >= MAX_COMMANDS) {
      throw new ParseError("too many commands to check");
    }
    this.shared.commands.push({ ...command, nesting: [...this.nesting] });
  }

  // -------------------------------------------------------------------------------------------
  // Redirections and here-documents
  // -------------------------------------------------------------------------------------------

  private atRedirect(): boolean {
    const rest = this.src.slice(this.pos, this.pos + 64);
    if (/^&>/.test(rest)) return true;
    if (/^\d+[<>]/.test(rest)) return !/^\d+[<>]\(/.test(rest);
    if (/^\{[A-Za-z_][A-Za-z0-9_]*\}[<>]/.test(rest)) return true;
    const c = rest[0];
    return (c === "<" || c === ">") && rest[1] !== "(";
  }

  private parseRedirect(): ShellRedirect {
    let fd: string | null = null;
    const fdMatch = /^(\d+|\{[A-Za-z_][A-Za-z0-9_]*\})(?=[<>])/.exec(
      this.src.slice(this.pos, this.pos + 64),
    );
    if (fdMatch?.[1] !== undefined) {
      fd = fdMatch[1];
      this.pos += fd.length;
    }
    const ops = ["<<<", "<<-", "<<", "<>", "<&", "<", "&>>", "&>", ">>", ">&", ">|", ">"];
    const op = ops.find((o) => this.startsWith(o));
    if (op === undefined) throw new ParseError("malformed redirection");
    this.pos += op.length;
    this.skipBlanks();
    const c = this.peek();
    if (c === undefined || isMeta(c)) throw new ParseError(`"${op}" has no target`);
    const target = this.readWord();
    if (op === "<<" || op === "<<-") {
      const quoted = /['"\\]/.test(target.raw);
      const delimiter = target.raw.replace(/['"\\]/g, "");
      const redirect: ShellRedirect = {
        op,
        fd,
        target: null,
        heredoc: { delimiter, quoted, body: "" },
      };
      this.pending.push({ redirect, strip: op === "<<-" });
      return redirect;
    }
    return { op, fd, target, heredoc: null };
  }

  private readHeredocBodies(): void {
    const pending = this.pending;
    this.pending = [];
    for (const { redirect, strip } of pending) {
      const doc = redirect.heredoc;
      if (doc === null) continue;
      let body = "";
      for (;;) {
        if (this.atEnd()) throw new ParseError(`here-document "${doc.delimiter}" is never closed`);
        const end = this.src.indexOf("\n", this.pos);
        const lineEnd = end === -1 ? this.src.length : end;
        const line = this.src.slice(this.pos, lineEnd);
        this.pos = end === -1 ? this.src.length : end + 1;
        const check = strip ? line.replace(/^\t+/, "") : line;
        if (check === doc.delimiter) break;
        if (!doc.quoted && line.endsWith("\\")) {
          throw new ParseError("a line continuation inside a here-document is not checked");
        }
        body += `${line}\n`;
      }
      doc.body = body;
      if (!doc.quoted) {
        // An unquoted delimiter means the body is expanded: substitutions in it run.
        const sub = new Parser(
          body,
          this.shared,
          [...this.nesting, "here-document"],
          this.depth + 1,
        );
        sub.scanExpandedText();
      }
    }
  }

  /** Scans text that the shell expands like the inside of double quotes, to its end. */
  scanExpandedText(): void {
    while (!this.atEnd()) {
      const c = this.peek();
      if (c === "\\") {
        this.pos += 2;
      } else if (c === "$") {
        this.readDollar([], true);
      } else if (c === "`") {
        this.readBacktick([], true);
      } else {
        this.pos++;
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Words
  // -------------------------------------------------------------------------------------------

  private readWord(options: { regex?: boolean } = {}): ShellWord {
    const segments: WordSegment[] = [];
    const start = this.pos;
    let raw = "";
    let parenDepth = 0;
    for (;;) {
      const c = this.peek();
      if (c === undefined) break;
      if (c === "\\") {
        const next = this.peek(1);
        if (next === "\n") {
          this.pos += 2;
          continue;
        }
        if (next === undefined) throw new ParseError("ends with a lone backslash");
        pushLiteral(segments, next, true);
        raw += c + next;
        this.pos += 2;
        continue;
      }
      if (c === "'") {
        const close = this.src.indexOf("'", this.pos + 1);
        if (close === -1) throw new ParseError("unterminated single quote");
        const text = this.src.slice(this.pos + 1, close);
        pushLiteral(segments, text, true);
        raw += this.src.slice(this.pos, close + 1);
        this.pos = close + 1;
        continue;
      }
      if (c === '"') {
        const from = this.pos;
        this.readDoubleQuoted(segments);
        raw += this.src.slice(from, this.pos).replace(/\\\n/g, "");
        continue;
      }
      if (c === "$") {
        const from = this.pos;
        this.readDollar(segments, false);
        raw += this.src.slice(from, this.pos);
        continue;
      }
      if (c === "`") {
        const from = this.pos;
        this.readBacktick(segments, false);
        raw += this.src.slice(from, this.pos);
        continue;
      }
      if ((c === "<" || c === ">") && this.peek(1) === "(") {
        const from = this.pos;
        this.pos += 2;
        this.parseUntilCloseParen("process substitution");
        const text = this.src.slice(from, this.pos);
        segments.push({ kind: "expansion", type: "process", raw: text, quoted: false });
        raw += text;
        continue;
      }
      if (options.regex === true && (c === "(" || c === ")" || c === "|")) {
        // Inside `[[ x =~ ... ]]` these are regular-expression characters.
        if (c === "(") parenDepth++;
        if (c === ")") parenDepth--;
        if (parenDepth < 0) throw new ParseError('unbalanced ")" in a "=~" pattern');
        pushLiteral(segments, c, false);
        raw += c;
        this.pos++;
        continue;
      }
      if (isMeta(c)) break;
      if ("@!+*?".includes(c) && this.peek(1) === "(") {
        throw new ParseError("extended glob patterns are not checked");
      }
      pushLiteral(segments, c, false);
      raw += c;
      this.pos++;
    }
    if (this.pos === start) throw new ParseError(`unexpected ${describeChar(this.peek())}`);
    if (segments.some((s) => s.kind === "literal" && s.quoted && /\$\(|`|\$\{/.test(s.text))) {
      this.shared.features.add("quoted_substitution_text");
    }
    return { raw, segments };
  }

  private readDoubleQuoted(segments: WordSegment[]): void {
    this.pos++;
    for (;;) {
      const c = this.peek();
      if (c === undefined) throw new ParseError("unterminated double quote");
      if (c === '"') {
        this.pos++;
        return;
      }
      if (c === "\\") {
        const next = this.peek(1);
        if (next === "\n") {
          this.pos += 2;
        } else if (next === "$" || next === "`" || next === '"' || next === "\\") {
          pushLiteral(segments, next, true);
          this.pos += 2;
        } else {
          pushLiteral(segments, "\\", true);
          this.pos++;
        }
        continue;
      }
      if (c === "$") {
        this.readDollar(segments, true);
        continue;
      }
      if (c === "`") {
        this.readBacktick(segments, true);
        continue;
      }
      pushLiteral(segments, c, true);
      this.pos++;
    }
  }

  /** Reads anything starting with `$` at the current position. */
  private readDollar(segments: WordSegment[], inQuotes: boolean): void {
    const start = this.pos;
    const next = this.peek(1);
    if (next === "'" && !inQuotes) {
      const { text, end } = decodeAnsiC(this.src, this.pos + 2);
      pushLiteral(segments, text, true);
      this.pos = end;
      return;
    }
    if (next === '"' && !inQuotes) {
      this.pos++;
      this.readDoubleQuoted(segments);
      return;
    }
    if (next === "(" && this.peek(2) === "(") {
      this.pos += 3;
      this.readArithmetic("))");
      this.shared.features.add("arithmetic");
      segments.push({
        kind: "expansion",
        type: "arithmetic",
        raw: this.src.slice(start, this.pos),
        quoted: inQuotes,
      });
      return;
    }
    if (next === "(") {
      this.pos += 2;
      this.parseUntilCloseParen("command substitution");
      segments.push({
        kind: "expansion",
        type: "command",
        raw: this.src.slice(start, this.pos),
        quoted: inQuotes,
      });
      return;
    }
    if (next === "[") {
      this.pos += 2;
      this.readArithmetic("]");
      this.shared.features.add("arithmetic");
      segments.push({
        kind: "expansion",
        type: "arithmetic",
        raw: this.src.slice(start, this.pos),
        quoted: inQuotes,
      });
      return;
    }
    if (next === "{") {
      this.pos += 2;
      this.readParameterExpansion(inQuotes);
      segments.push({
        kind: "expansion",
        type: "parameter",
        raw: this.src.slice(start, this.pos),
        quoted: inQuotes,
      });
      return;
    }
    if (next !== undefined && /[A-Za-z_]/.test(next)) {
      this.pos++;
      while (/[A-Za-z0-9_]/.test(this.peek() ?? "")) this.pos++;
      segments.push({
        kind: "expansion",
        type: "parameter",
        raw: this.src.slice(start, this.pos),
        quoted: inQuotes,
      });
      return;
    }
    if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
      this.pos += 2;
      segments.push({
        kind: "expansion",
        type: "parameter",
        raw: this.src.slice(start, this.pos),
        quoted: inQuotes,
      });
      return;
    }
    // A lone "$" is literal.
    pushLiteral(segments, "$", inQuotes);
    this.pos++;
  }

  private readParameterExpansion(inQuotes: boolean): void {
    if (this.peek() === "(") throw new ParseError("parameter flags are not checked");
    const contentStart = this.pos;
    let depth = 0;
    for (;;) {
      const c = this.peek();
      if (c === undefined) throw new ParseError('unterminated "${"');
      if (c === "}" && depth === 0) break;
      if (c === "{") depth++;
      else if (c === "}") depth--;
      if (c === "\\") {
        this.pos += 2;
      } else if (c === "'" && !inQuotes) {
        // Inside double quotes a single quote here is an ordinary character.
        const close = this.src.indexOf("'", this.pos + 1);
        if (close === -1) throw new ParseError("unterminated single quote");
        this.pos = close + 1;
      } else if (c === '"') {
        this.readDoubleQuoted([]);
      } else if (c === "$") {
        this.readDollar([], true);
      } else if (c === "`") {
        this.readBacktick([], true);
      } else {
        this.pos++;
      }
    }
    const content = this.src.slice(contentStart, this.pos);
    this.pos++;
    // Subscripts, indirection (`${!x}`) and substring offsets (`${x:n}`) evaluate values.
    if (content.includes("[") || content.startsWith("!")) this.shared.features.add("subscript");
    if (/^[^:]*:(?![-=?+])/.test(content)) this.shared.features.add("arithmetic");
    // Prompt expansion (`${x@P}`) runs command substitutions found in the variable's value.
    if (/@P/.test(content)) throw new ParseError("prompt expansion is not checked");
  }

  private readArithmetic(close: string): void {
    let depth = 0;
    for (;;) {
      const c = this.peek();
      if (c === undefined) throw new ParseError("unterminated arithmetic expansion");
      if (depth === 0 && this.startsWith(close)) {
        this.pos += close.length;
        return;
      }
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (c === "$") {
        this.readDollar([], true);
      } else if (c === "`") {
        this.readBacktick([], true);
      } else if (c === '"') {
        this.readDoubleQuoted([]);
      } else if (c === "\\") {
        this.pos += 2;
      } else {
        this.pos++;
      }
    }
  }

  private readBacktick(segments: WordSegment[], inQuotes: boolean): void {
    const start = this.pos;
    let inner = "";
    let j = this.pos + 1;
    for (;;) {
      const c = this.src[j];
      if (c === undefined) throw new ParseError("unterminated backtick");
      if (c === "`") break;
      if (c === "\\") {
        const next = this.src[j + 1];
        if (next === "`" || next === "\\" || next === "$" || (inQuotes && next === '"')) {
          inner += next;
          j += 2;
          continue;
        }
        if (next === "\n") {
          j += 2;
          continue;
        }
      }
      inner += c;
      j++;
    }
    this.pos = j + 1;
    const sub = new Parser(
      inner,
      this.shared,
      [...this.nesting, "command substitution"],
      this.depth + 1,
    );
    sub.parseProgram();
    segments.push({
      kind: "expansion",
      type: "command",
      raw: this.src.slice(start, this.pos),
      quoted: inQuotes,
    });
  }
}

function pushLiteral(segments: WordSegment[], text: string, quoted: boolean): void {
  const last = segments[segments.length - 1];
  if (last?.kind === "literal" && last.quoted === quoted) {
    last.text += text;
  } else {
    segments.push({ kind: "literal", text, quoted });
  }
}

function literalWord(text: string): ShellWord {
  return { raw: text, segments: [{ kind: "literal", text, quoted: false }] };
}

function describeChar(c: string | undefined): string {
  if (c === undefined) return "end of command";
  if (c === "\n") return "line break";
  return `"${c}"`;
}

/** Decodes the body of `$'...'` starting just after the opening quote. */
function decodeAnsiC(src: string, from: number): { text: string; end: number } {
  let text = "";
  let j = from;
  for (;;) {
    const c = src[j];
    if (c === undefined) throw new ParseError("unterminated $'...' quote");
    if (c === "'") return { text, end: j + 1 };
    if (c !== "\\") {
      text += c;
      j++;
      continue;
    }
    const e = src[j + 1];
    if (e === undefined) throw new ParseError("unterminated $'...' quote");
    const simple: Record<string, string> = {
      a: "\x07",
      b: "\b",
      e: "\x1b",
      E: "\x1b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      "'": "'",
      '"': '"',
      "?": "?",
    };
    const mapped = simple[e];
    if (mapped !== undefined) {
      text += mapped;
      j += 2;
      continue;
    }
    const rest = src.slice(j + 1, j + 11);
    const octal = /^[0-7]{1,3}/.exec(rest);
    const hex = /^x([0-9A-Fa-f]{1,2})/.exec(rest);
    const u4 = /^u([0-9A-Fa-f]{1,4})/.exec(rest);
    const u8 = /^U([0-9A-Fa-f]{1,8})/.exec(rest);
    if (octal !== null) {
      text += String.fromCharCode(Number.parseInt(octal[0], 8));
      j += 1 + octal[0].length;
    } else if (hex?.[1] !== undefined) {
      text += String.fromCharCode(Number.parseInt(hex[1], 16));
      j += 1 + hex[0].length;
    } else if (u4?.[1] !== undefined) {
      text += String.fromCodePoint(Number.parseInt(u4[1], 16));
      j += 1 + u4[0].length;
    } else if (u8?.[1] !== undefined) {
      const cp = Number.parseInt(u8[1], 16);
      if (cp > 0x10ffff) throw new ParseError("invalid $'\\U' escape");
      text += String.fromCodePoint(cp);
      j += 1 + u8[0].length;
    } else if (e === "c" && src[j + 2] !== undefined) {
      text += String.fromCharCode((src.charCodeAt(j + 2) & 0x1f) >>> 0);
      j += 3;
    } else {
      text += `\\${e}`;
      j += 2;
    }
  }
}

/** The word's value when nothing in it is computed at run time, else null. */
export function staticValue(word: ShellWord): string | null {
  let out = "";
  for (const s of word.segments) {
    if (s.kind !== "literal") return null;
    out += s.text;
  }
  return out;
}

/** True when the word contains an unquoted `*`, `?`, or a `[` closed by a later `]`. */
export function hasUnquotedGlob(word: ShellWord): boolean {
  if (word.segments.some((s) => s.kind === "literal" && !s.quoted && /[*?]/.test(s.text)))
    return true;
  // A bracket expression may span quoted parts (`["a"]`), so look at the whole word.
  const text = word.segments
    .map((s) => (s.kind === "literal" ? (s.quoted ? s.text.replace(/[[\]]/g, "_") : s.text) : "_"))
    .join("");
  return /\[[^\]]*\]/.test(text.replace(/^\[\[?$/, ""));
}

/** True when the word contains an unquoted brace expansion such as `{a,b}` or `{1..3}`. */
export function hasBraceExpansion(word: ShellWord): boolean {
  const unquoted = word.segments
    .map((s) => (s.kind === "literal" && !s.quoted ? s.text : "\n"))
    .join("");
  // Quoted parts are replaced by a line break, which an unquoted literal cannot contain.
  return /\{[^{}\n]*(,|\.\.)[^{}\n]*\}/.test(unquoted);
}

/** True when the word is computed at run time (any expansion). */
export function isDynamic(word: ShellWord): boolean {
  return word.segments.some((s) => s.kind === "expansion");
}

/** True when the word is a single process substitution such as `<(ls)`. */
export function isProcessSubstitution(word: ShellWord): boolean {
  return (
    word.segments.length === 1 &&
    word.segments[0]?.kind === "expansion" &&
    word.segments[0].type === "process"
  );
}

/** The leading `~` form of an unquoted word: "home" for `~` or `~/...`, "user" for `~name`. */
export function tildePrefix(word: ShellWord): "home" | "user" | null {
  const first = word.segments[0];
  if (first?.kind !== "literal" || first.quoted || !first.text.startsWith("~")) return null;
  const rest = first.text.slice(1);
  if (rest === "" && word.segments.length > 1) {
    // `~"x"` is `~x`, a user's home.
    return "user";
  }
  if (rest === "" || rest.startsWith("/")) return "home";
  return "user";
}

/** The variable name an assignment word sets, or null when the word is not an assignment. */
export function assignmentName(word: ShellWord): string | null {
  let prefix = "";
  for (const s of word.segments) {
    if (s.kind !== "literal" || s.quoted) break;
    prefix += s.text;
    if (prefix.includes("=")) break;
  }
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?\+?=/.exec(prefix);
  if (m?.[1] !== undefined) return m[1];
  // An array element whose subscript is computed: `a[$i]=1`.
  const sub = /^([A-Za-z_][A-Za-z0-9_]*)\[[^\]]*\]\+?=/.exec(word.raw);
  return sub?.[1] ?? null;
}

/** Parses a command line. Never throws. */
export function parseShell(source: string): ParseResult {
  const shared: SharedState = { commands: [], loopVariables: [], features: new Set() };
  try {
    new Parser(source, shared, [], 0).parseProgram();
    return { ...shared, error: null };
  } catch (err) {
    const error =
      err instanceof ParseError
        ? err.message
        : err instanceof RangeError
          ? "nested too deeply to check"
          : "could not be read";
    return { ...shared, error };
  }
}
