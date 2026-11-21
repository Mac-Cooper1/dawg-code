// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell command lines, not templates
/**
 * Properties over many generated calls and rule sets:
 * - parsing, analysis and deciding never throw;
 * - adding a deny (or ask) rule never turns a deny or ask into an allow;
 * - removing an allow rule never turns an ask or deny into an allow;
 * - a suggestion, once saved, really allows the call.
 */
import type { PermissionMode } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import type {
  PermissionDecision,
  PermissionQuery,
  PermissionState,
} from "../contracts/permissions.ts";
import { fakeFs, HOME, localFile, PROJECT, projectFile, userFile } from "./__fixtures__/helpers.ts";
import { decidePermission } from "./decide.ts";
import { analyzeCommand } from "./shell/analyze.ts";
import { parseShell } from "./shell/parse.ts";

/** A small, seeded random number generator, so failures reproduce. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  return { next, pick };
}

const TOKENS = [
  "ls",
  "cat",
  "rm",
  "-rf",
  "git",
  "status",
  "push",
  "echo",
  "npm",
  "test",
  "sudo",
  "bash",
  "-c",
  "sh",
  "eval",
  "find",
  ".",
  "-exec",
  "{}",
  "\\;",
  "xargs",
  "env",
  "FOO=1",
  "PATH=x",
  "timeout",
  "5",
  "cd",
  "src",
  "/etc/passwd",
  "~/.ssh/id_rsa",
  ".git/config",
  ".dawg/settings.json",
  "*.ts",
  "{a,b}",
  "$X",
  "${Y}",
  "$(",
  ")",
  "`",
  "'",
  '"',
  "\\",
  ";",
  "&&",
  "||",
  "|",
  "|&",
  "&",
  "\n",
  ">",
  ">>",
  "<",
  "2>&1",
  "<<EOF\n",
  "EOF",
  "<<<",
  "<(",
  ">(",
  "(",
  "{",
  "}",
  "[[",
  "]]",
  "if",
  "then",
  "fi",
  "for",
  "in",
  "do",
  "done",
  "case",
  "esac",
  "#",
  "\\\n",
  "$((",
  "))",
  "$'\\x72'",
  "!",
  "f()",
  "x='$(id)'",
  "../x",
  "link/../y",
  "~bob",
  "-",
  "--",
  "-o",
  "out",
  "sed",
  "-i",
  "s/a/b/",
  "tee",
  "\r",
  "‮",
];

const PATHS = [
  `${PROJECT}/src/a.ts`,
  `${PROJECT}/.env`,
  `${PROJECT}/.git/config`,
  `${PROJECT}/.GIT/HEAD`,
  `${PROJECT}/.dawg/settings.local.json`,
  `${PROJECT}/link/x`,
  `${PROJECT}/../outside/x`,
  "/etc/hosts",
  `${HOME}/.ssh/id_rsa`,
  `${HOME}/notes.md`,
  "/tmp/x",
  `${PROJECT}/secrets/a`,
  `${PROJECT}/loop/x`,
  `${PROJECT}/docs/../src/b.ts`,
  "/",
  PROJECT,
];

const RULES = [
  "Bash",
  "Bash(*)",
  "Bash(ls *)",
  "Bash(rm *)",
  "Bash(git status)",
  "Bash(git *)",
  "Bash(npm test *)",
  "Bash(echo:*)",
  "Bash(* --help)",
  "Bash(sudo *)",
  "Bash(find *)",
  "Bash(cat *)",
  "Read",
  "Edit",
  "Read(.env)",
  "Read(~/.ssh/**)",
  "Read(//etc/**)",
  "Read(secrets/**)",
  "Read(!secrets/a)",
  "Edit(src/**)",
  "Edit(/src/**)",
  "Edit(**)",
  "Edit(//tmp/**)",
  "Edit(.git/**)",
  "Write(docs/**)",
  "WebFetch",
  "WebFetch(domain:*.example.com)",
  "mcp__*",
  "*",
  "TodoWrite",
  "Bash(ls) x",
  "Read(",
  "Bash(command:rm *)",
  "Grep(secrets/**)",
  "Read(~/notes.md)",
];

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];
const SOURCES = [projectFile, localFile, userFile];

const fs = fakeFs({
  dirs: [`${PROJECT}/src`, `${PROJECT}/.git`, "/outside", `${HOME}/.ssh`],
  files: [`${PROJECT}/src/a.ts`, `${HOME}/.ssh/id_rsa`],
  links: {
    [`${PROJECT}/link`]: "/outside",
    [`${PROJECT}/secrets`]: `${HOME}/.ssh`,
    [`${PROJECT}/loop`]: "loop",
  },
});

function randomCommand(r: ReturnType<typeof rng>): string {
  const n = 1 + Math.floor(r.next() * 10);
  let out = "";
  for (let i = 0; i < n; i++) out += (r.next() < 0.7 ? " " : "") + r.pick(TOKENS);
  return out.trim();
}

function randomQuery(r: ReturnType<typeof rng>): PermissionQuery {
  const k = r.next();
  if (k < 0.5) return { toolName: "Bash", subject: { kind: "command", command: randomCommand(r) } };
  if (k < 0.65)
    return {
      toolName: r.pick(["Read", "Grep", "Glob"]),
      subject: { kind: "read", paths: [r.pick(PATHS)] },
    };
  if (k < 0.85)
    return {
      toolName: r.pick(["Edit", "Write"]),
      subject: { kind: "edit", paths: [r.pick(PATHS), ...(r.next() < 0.3 ? [r.pick(PATHS)] : [])] },
    };
  if (k < 0.95)
    return {
      toolName: r.pick(["WebFetch", "mcp__x__y"]),
      subject: {
        kind: "other",
        specifier: r.pick([null, "domain:a.example.com", "domain:evil.com"]),
      },
    };
  return { toolName: r.pick(["TodoWrite", "AskUserQuestion"]), subject: { kind: "none" } };
}

function randomState(r: ReturnType<typeof rng>): PermissionState {
  const rules = () => {
    const n = Math.floor(r.next() * 4);
    return Array.from({ length: n }, () => ({ rule: r.pick(RULES), from: r.pick(SOURCES) }));
  };
  return {
    mode: r.pick(MODES),
    rules: { allow: rules(), ask: rules(), deny: rules() },
    cwd: PROJECT,
    workingDirectories: [PROJECT],
    homeDir: HOME,
  };
}

function valid(d: PermissionDecision): boolean {
  if (d.behavior === "allow") return typeof d.reason === "object";
  if (d.behavior === "ask")
    return Array.isArray(d.suggestions) && d.suggestions.every((s) => typeof s === "string");
  return d.behavior === "deny" && typeof d.message === "string" && d.message.length > 0;
}

const ITERATIONS = 1500;

describe("properties", () => {
  it("parsing and analysis never throw", () => {
    const r = rng(1);
    for (let i = 0; i < ITERATIONS * 2; i++) {
      const c = randomCommand(r);
      expect(() => parseShell(c), c).not.toThrow();
      expect(() => analyzeCommand(c, { cwd: PROJECT, homeDir: HOME }), c).not.toThrow();
    }
    // Arbitrary characters, not just shell tokens.
    for (let i = 0; i < ITERATIONS; i++) {
      const c = Array.from({ length: Math.floor(r.next() * 40) }, () =>
        String.fromCharCode(Math.floor(r.next() * 128)),
      ).join("");
      expect(
        () => analyzeCommand(c, { cwd: PROJECT, homeDir: HOME }),
        JSON.stringify(c),
      ).not.toThrow();
    }
  });

  it("deciding never throws and always returns a well-formed decision", () => {
    const r = rng(2);
    for (let i = 0; i < ITERATIONS; i++) {
      const q = randomQuery(r);
      const s = randomState(r);
      const d = decidePermission(q, s, { fs });
      expect(valid(d), JSON.stringify({ q, s, d })).toBe(true);
    }
  });

  it("adding a deny or ask rule never turns a deny or ask into an allow", () => {
    const r = rng(3);
    for (let i = 0; i < ITERATIONS; i++) {
      const q = randomQuery(r);
      const s = randomState(r);
      const before = decidePermission(q, s, { fs });
      if (before.behavior === "allow") continue;
      for (const list of ["deny", "ask"] as const) {
        const extra = { rule: r.pick(RULES), from: r.pick(SOURCES) };
        const more: PermissionState = {
          ...s,
          rules: { ...s.rules, [list]: [...s.rules[list], extra] },
        };
        const after = decidePermission(q, more, { fs });
        const context = JSON.stringify({
          q,
          s,
          extra,
          list,
          before: before.behavior,
          after: after.behavior,
        });
        expect(after.behavior, context).not.toBe("allow");
        if (list === "deny" && before.behavior === "deny")
          expect(after.behavior, context).toBe("deny");
      }
    }
  });

  it("removing an allow rule never turns an ask or deny into an allow", () => {
    const r = rng(4);
    let checked = 0;
    for (let i = 0; i < ITERATIONS * 2; i++) {
      const q = randomQuery(r);
      const s = randomState(r);
      if (s.rules.allow.length === 0) continue;
      const before = decidePermission(q, s, { fs });
      if (before.behavior === "allow") continue;
      const drop = Math.floor(r.next() * s.rules.allow.length);
      const fewer: PermissionState = {
        ...s,
        rules: { ...s.rules, allow: s.rules.allow.filter((_, j) => j !== drop) },
      };
      const after = decidePermission(q, fewer, { fs });
      expect(after.behavior, JSON.stringify({ q, s, drop })).not.toBe("allow");
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("a saved suggestion allows the call it was offered for", () => {
    const r = rng(5);
    let offered = 0;
    for (let i = 0; i < ITERATIONS * 2; i++) {
      const q = randomQuery(r);
      const s = { ...randomState(r), mode: "default" as const };
      const d = decidePermission(q, s, { fs });
      if (d.behavior !== "ask" || d.suggestions.length === 0) continue;
      offered++;
      const saved: PermissionState = {
        ...s,
        rules: {
          ...s.rules,
          allow: [...s.rules.allow, ...d.suggestions.map((rule) => ({ rule, from: localFile }))],
        },
      };
      expect(decidePermission(q, saved, { fs }).behavior, JSON.stringify({ q, d })).toBe("allow");
    }
    expect(offered).toBeGreaterThan(20);
  });
});
