import { describe, expect, it } from "vitest";
import {
  FuzzyIndex,
  type FuzzyTarget,
  fuzzyMatch,
  fuzzySearch,
  normalizeQuery,
  prepareTarget,
} from "./fuzzy.ts";

function search(query: string, paths: string[], limit = 10): string[] {
  return fuzzySearch(query, paths.map(prepareTarget), limit).map((match) => match.target.text);
}

/** The matched characters, marked: "src/[m]oney.py". */
function marked(query: string, path: string): string | null {
  const match = fuzzyMatch(query, prepareTarget(path));
  if (!match) return null;
  const set = new Set(match.positions);
  return [...path].map((char, index) => (set.has(index) ? `[${char}]` : char)).join("");
}

describe("prepareTarget", () => {
  it("finds the basename and depth of files and folders", () => {
    expect(prepareTarget("a.ts")).toMatchObject({ baseStart: 0, depth: 0, directory: false });
    expect(prepareTarget("src/lib/a.ts")).toMatchObject({ baseStart: 8, depth: 2 });
    expect(prepareTarget("src/lib/")).toMatchObject({ baseStart: 4, depth: 1, directory: true });
    expect(prepareTarget("src/")).toMatchObject({ baseStart: 0, depth: 0, directory: true });
  });

  it("keeps positions aligned when lower-casing changes a character's length", () => {
    const target = prepareTarget("İndex/Ab.ts");
    expect(target.lower).toHaveLength(target.text.length);
    expect(marked("ab", "İndex/Ab.ts")).toBe("İndex/[A][b].ts");
  });
});

describe("matching", () => {
  it("matches a subsequence, ignoring case, and nothing else", () => {
    expect(marked("mny", "src/Money.py")).toBe("src/[M]o[n]e[y].py");
    expect(fuzzyMatch("ymn", prepareTarget("src/money.py"))).toBeNull();
    expect(fuzzyMatch("moneys", prepareTarget("money"))).toBeNull();
    expect(fuzzyMatch("", prepareTarget("money"))).toBeNull();
  });

  it("places matches at word starts rather than the first place they fit", () => {
    expect(marked("fb", "src/foo_bar.ts")).toBe("src/[f]oo_[b]ar.ts");
    expect(marked("ub", "src/userButton.tsx")).toBe("src/[u]ser[B]utton.tsx");
    expect(marked("sc", "src/components/scroll.ts")).toBe("src/components/[s][c]roll.ts");
  });

  it("prefers a consecutive run", () => {
    expect(marked("test", "tests/the_test.ts")).toBe("tests/the_[t][e][s][t].ts");
    expect(marked("app", "apps/desktop/app.ts")).toBe("apps/desktop/[a][p][p].ts");
  });

  it("matches across folders with a slash in the query", () => {
    expect(marked("src/mo", "src/tally/money.py")).toBe("[s][r][c][/]tally/[m][o]ney.py");
  });

  it("ignores spaces and a leading ./ in the query", () => {
    expect(normalizeQuery(" ./src/a b ")).toBe("src/ab");
    expect(marked("./mo ney", "money.py")).toBe("[m][o][n][e][y].py");
  });
});

describe("ranking", () => {
  it("puts an exact basename first, with or without its extension", () => {
    const paths = ["src/moneybag.ts", "lib/money/index.ts", "docs/money.md", "src/tally/money.py"];
    expect(search("money", paths).slice(0, 2)).toEqual(["docs/money.md", "src/tally/money.py"]);
    expect(search("money.py", paths)[0]).toBe("src/tally/money.py");
  });

  it("prefers basename matches over matches spread through folders", () => {
    const paths = ["components/button/index.ts", "src/cb.ts", "src/combobox.tsx"];
    expect(search("cb", paths)[0]).toBe("src/cb.ts");
    expect(search("combo", paths)[0]).toBe("src/combobox.tsx");
  });

  it("prefers word starts and camel humps", () => {
    const paths = ["src/fooBarBaz.ts", "src/fobrabaz.ts"];
    expect(search("fbb", paths)[0]).toBe("src/fooBarBaz.ts");
  });

  it("breaks ties with shorter and shallower paths", () => {
    const paths = ["a/b/c/d/readme.md", "readme.md", "docs/readme.md"];
    expect(search("readme", paths)).toEqual(["readme.md", "docs/readme.md", "a/b/c/d/readme.md"]);
  });

  it("ranks a file above a folder of the same name", () => {
    expect(search("money", ["money/", "money.py"])).toEqual(["money.py", "money/"]);
  });

  it("gives an exact case a small edge", () => {
    expect(search("Readme", ["readme.md", "README.md", "Readme.md"])[0]).toBe("Readme.md");
  });

  it("keeps at most the limit, best first, with highlights", () => {
    const paths = Array.from({ length: 30 }, (_, i) => `file${i}.ts`);
    const matches = fuzzySearch("file", paths.map(prepareTarget), 5);
    expect(matches).toHaveLength(5);
    expect(matches.map((m) => m.target.text)).toEqual([
      "file0.ts",
      "file1.ts",
      "file2.ts",
      "file3.ts",
      "file4.ts",
    ]);
    expect(matches[0]?.positions).toEqual([0, 1, 2, 3]);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(matches[i]?.score ?? 0);
    }
  });

  it("returns highlights that spell the query", () => {
    const paths = ["apps/desktop/src/renderer/composer/Composer.tsx", "src/compose.ts"];
    for (const match of fuzzySearch("rcomp", paths.map(prepareTarget), 5)) {
      const spelled = match.positions.map((i) => match.target.text[i]).join("");
      expect(spelled.toLowerCase()).toBe("rcomp");
    }
  });
});

/** A repository-shaped tree of `count` paths. */
function syntheticPaths(count: number): FuzzyTarget[] {
  const words = ["src", "lib", "test", "components", "utils", "app", "core", "server", "client"];
  const names = ["index", "main", "button", "router", "store", "money", "parser", "config"];
  const exts = [".ts", ".tsx", ".py", ".md", ".json", ".css"];
  const targets: FuzzyTarget[] = [];
  let seed = 7;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >>> 16) % n;
  };
  for (let i = 0; i < count; i++) {
    const depth = 1 + next(5);
    const parts: string[] = [];
    for (let d = 0; d < depth; d++) parts.push(`${words[next(words.length)]}${next(40)}`);
    parts.push(`${names[next(names.length)]}${i}${exts[next(exts.length)]}`);
    targets.push(prepareTarget(parts.join("/")));
  }
  return targets;
}

describe("FuzzyIndex", () => {
  it("answers as a fresh search does while a query is typed, extended and taken back", () => {
    const targets = syntheticPaths(5000);
    const index = new FuzzyIndex(targets);
    const text = (matches: { target: FuzzyTarget }[]) => matches.map((m) => m.target.text);
    for (const query of ["m", "mo", "mon", "mone", "money", "mone", "mo", "m", "mi", "s", "sr/b"]) {
      expect(text(index.search(query, 20)), query).toEqual(text(fuzzySearch(query, targets, 20)));
    }
    expect(index.search("", 20)).toEqual([]);
  });

  it("scores only the earlier query's matches while it is extended", () => {
    const targets = syntheticPaths(5000);
    const index = new FuzzyIndex(targets);
    const matching = (query: string) => fuzzySearch(query, targets, targets.length).length;
    index.search("mo", 20);
    expect(index.lastScored).toBe(targets.length);
    index.search("mon", 20);
    expect(index.lastScored).toBe(matching("mo"));
    index.search("money", 20);
    expect(index.lastScored).toBe(matching("mon"));
    expect(matching("mon")).toBeLessThan(targets.length);
    // Taken back to a query no earlier one starts: everything again.
    index.search("m", 20);
    expect(index.lastScored).toBe(targets.length);
    // Back to "mo", remembered: its own matches.
    index.search("mo", 20);
    expect(index.lastScored).toBe(matching("mo"));
  });

  it("finds one-character matches at the best place", () => {
    expect(marked("b", "lib/Button.tsx")).toBe("lib/[B]utton.tsx");
    expect(marked("x", "a.ts")).toBeNull();
  });
});

describe("speed", () => {
  /**
   * The fastest time of each piece of work over several rounds, taking turns so both see the
   * same load from other programs (which only ever adds time).
   */
  function fastest(rounds: number, ...works: (() => void)[]): number[] {
    const best = works.map(() => Number.POSITIVE_INFINITY);
    for (let round = 0; round < rounds; round++) {
      works.forEach((work, index) => {
        const started = performance.now();
        work();
        best[index] = Math.min(best[index] ?? 0, performance.now() - started);
      });
    }
    return best;
  }

  // Wall-clock bounds fail on slow or busy machines, so each query is timed against a yardstick
  // taken on the same machine at the same moments: reading every path once, which any search
  // must at least do. Searches take 0.1–2 times that (about 20 ms on a recent Mac).
  it("searches 100,000 paths in a small multiple of the time it takes to read them", {
    timeout: 120_000,
  }, () => {
    const targets = syntheticPaths(100_000);
    let sink = 0;
    const read = () => {
      for (const target of targets) {
        const text = target.lower;
        for (let i = 0; i < text.length; i++) sink += text.charCodeAt(i);
      }
    };
    for (const query of ["m", "s", "src", "money", "srccomp", "comp/btn", "zzzz"]) {
      const [reading = 0, searching = 0] = fastest(7, read, () => {
        fuzzySearch(query, targets, 50);
      });
      expect(
        searching,
        `"${query}" took ${searching.toFixed(1)} ms; reading took ${reading.toFixed(1)} ms`,
      ).toBeLessThan(Math.max(reading * 8, 5));
    }
    expect(sink).toBeGreaterThan(0);
  });
});
