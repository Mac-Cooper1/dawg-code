/**
 * "Docs search page": queued behind "fix-split" for the one local model. The stored part is only
 * the queued start of the turn; the live part runs once fix-split's turn ends.
 */
import type { ScenarioDefinition } from "../define.ts";
import { MINUTE, Recordings, recorder, settings } from "../define.ts";
import {
  callBash,
  callGlob,
  callRead,
  callWrite,
  runBash,
  runGlob,
  runRead,
  runWrite,
} from "../tools.ts";

const ID = "docs-search";
const CWD = "~/code/dawg-site";
/** The status line while the turn waits for the model, as the engine words it. */
export const QUEUED_MESSAGE = "Waiting for the model";

/** "$": file text below holds JavaScript template literals, written `${D}{x}` so lint does not take them for mistakes. */
const D = "$";

const ASTRO_CONFIG = [
  'import { defineConfig } from "astro/config";',
  'import mdx from "@astrojs/mdx";',
  'import sitemap from "@astrojs/sitemap";',
  "",
  "export default defineConfig({",
  '  site: "https://dawg-code.dev",',
  '  trailingSlash: "never",',
  "  integrations: [mdx(), sitemap()],",
  "  markdown: {",
  "    shikiConfig: {",
  '      themes: { light: "github-light", dark: "github-dark" },',
  "    },",
  "  },",
  "  redirects: {",
  '    "/docs/[...slug]": "/guide/[...slug]",',
  "  },",
  "});",
];

const DOCS = [
  "src/content/docs/getting-started.md",
  "src/content/docs/models.md",
  "src/content/docs/sessions.md",
  "src/content/docs/worktrees.md",
  "src/content/docs/permissions.md",
  "src/content/docs/plan-mode.md",
  "src/content/docs/commands.md",
  "src/content/docs/settings.md",
  "src/content/docs/keyboard.md",
  "src/content/docs/troubleshooting.md",
  "src/content/docs/faq.md",
  "src/content/docs/privacy.md",
];

const INDEX_SCRIPT = [
  "// Builds the search index at build time: one entry per heading, with its section's text.",
  'import { getCollection } from "astro:content";',
  "",
  "export interface SearchEntry {",
  "  title: string;",
  "  heading: string;",
  "  url: string;",
  "  text: string;",
  "}",
  "",
  "export async function buildIndex(): Promise<SearchEntry[]> {",
  '  const docs = await getCollection("docs");',
  "  return docs.flatMap((doc) => {",
  "    const sections = doc.body.split(/^## /m);",
  "    return sections.map((section, i) => {",
  '      const [first = "", ...rest] = section.split("\\n");',
  "      const heading = i === 0 ? doc.data.title : first.trim();",
  `      const anchor = i === 0 ? "" : \`#${D}{heading.toLowerCase().replace(/[^a-z0-9]+/g, "-")}\`;`,
  "      return {",
  "        title: doc.data.title,",
  "        heading,",
  `        url: \`/guide/${D}{doc.id}${D}{anchor}\`,`,
  '        text: rest.join(" ").replace(/[#*`>_[\\]()]/g, "").slice(0, 600),',
  "      };",
  "    });",
  "  });",
  "}",
  "",
].join("\n");

const SEARCH_PAGE = [
  "---",
  'import Layout from "../layouts/Layout.astro";',
  'import { buildIndex } from "../scripts/search-index";',
  "",
  "const index = await buildIndex();",
  "---",
  "",
  '<Layout title="Search the docs">',
  "  <h1>Search the docs</h1>",
  '  <input id="q" type="search" placeholder="Search, for example “worktree”" autofocus />',
  '  <ol id="results" aria-live="polite"></ol>',
  '  <script id="index" type="application/json" set:html={JSON.stringify(index)} />',
  "  <script>",
  '    const index = JSON.parse(document.getElementById("index").textContent);',
  '    const input = document.getElementById("q");',
  '    const list = document.getElementById("results");',
  "    const score = (entry, words) =>",
  "      words.reduce((n, w) => n + (entry.heading.toLowerCase().includes(w) ? 3 : 0) +",
  "        (entry.text.toLowerCase().includes(w) ? 1 : 0), 0);",
  "    function show() {",
  "      const words = input.value.toLowerCase().split(/\\s+/).filter(Boolean);",
  "      const hits = words.length === 0 ? [] : index",
  "        .map((entry) => ({ entry, n: score(entry, words) }))",
  "        .filter((hit) => hit.n > 0)",
  "        .sort((a, b) => b.n - a.n)",
  "        .slice(0, 20);",
  "      list.replaceChildren(...hits.map(({ entry }) => {",
  '        const item = document.createElement("li");',
  '        const link = document.createElement("a");',
  "        link.href = entry.url;",
  `        link.textContent = \`${D}{entry.title} › ${D}{entry.heading}\`;`,
  "        item.append(link);",
  "        return item;",
  "      }));",
  "    }",
  '    input.addEventListener("input", show);',
  '    const initial = new URLSearchParams(location.search).get("q");',
  "    if (initial) { input.value = initial; show(); }",
  "  </script>",
  "</Layout>",
  "",
].join("\n");

const BUILD_OUTPUT = [
  "",
  "> dawg-site@0.4.0 build ~/code/dawg-site",
  "> astro build",
  "",
  "09:41:12 [content] Syncing content",
  "09:41:12 [content] Synced content",
  "09:41:13 [types] Generated 412ms",
  '09:41:13 [build] output: "static"',
  "09:41:13 [build] Collecting build info...",
  "09:41:14 [build] ✓ Completed in 1.02s.",
  "09:41:14 [build] Building static entrypoints...",
  "09:41:17 [vite] ✓ built in 2.71s",
  "09:41:17 ▶ src/pages/search.astro",
  "09:41:17   └─ /search/index.html (+18ms)",
  "09:41:18 ✓ Completed in 1.24s.",
  "09:41:18 [build] 27 page(s) built in 5.48s",
  "09:41:18 [build] Complete!",
  "",
].join("\n");

export function docsSearch(): ScenarioDefinition {
  const out = new Recordings();
  const rec = recorder({
    id: ID,
    cwd: CWD,
    seed: 61,
    settings: settings({ title: "Docs search page", mode: "acceptEdits" }),
  });

  rec.startTurn("Add a search page to the docs. Client-side only, no server.", {
    statusMessage: QUEUED_MESSAGE,
    queuePosition: 1,
  });
  out.add("stored.jsonl", rec);

  // Live, once the model is free.
  rec.wait(MINUTE);
  rec.status("working");
  let m = rec.message({ latencyMs: 1_100, completionExtra: 700 });
  m.think(
    "Client-side search means building an index at build time and searching it in the page. Find the docs and the site config first.",
  );
  const glob = callGlob(m, "src/content/docs/**/*.md");
  m.end();
  runGlob(rec, glob, DOCS);
  m = rec.message({ extra: 900, latencyMs: 1_600, completionExtra: 500 });
  const config = callRead(m, rec, "astro.config.mjs");
  m.end();
  runRead(rec, config, ASTRO_CONFIG);
  m = rec.message({ extra: 600, latencyMs: 1_900, completionExtra: 900 });
  const script = callWrite(m, rec, "src/scripts/search-index.ts", INDEX_SCRIPT);
  m.end();
  runWrite(rec, script);
  m = rec.message({ extra: 400, latencyMs: 1_700, completionExtra: 700 });
  const page = callWrite(m, rec, "src/pages/search.astro", SEARCH_PAGE);
  m.end();
  runWrite(rec, page);
  m = rec.message({ extra: 300, latencyMs: 1_300, completionExtra: 200 });
  const build = callBash(m, "pnpm build", "Build the site");
  m.end();
  runBash(rec, build, { output: BUILD_OUTPUT, exitCode: 0, durationMs: 6_400 });
  m = rec.message({ extra: 500, latencyMs: 1_500, completionExtra: 400 });
  m.say(
    [
      "The docs have a search page at `/search`, with no server involved:",
      "",
      "- `src/scripts/search-index.ts` builds an index at build time, one entry per heading.",
      "- `src/pages/search.astro` embeds it and searches as you type; headings rank above body text.",
      "- `/search?q=worktree` opens with that search filled in, so the header can link to it.",
      "",
      "The build passes. The index is about 40 KB for the 12 pages; past a few hundred pages it would be worth loading it on demand.",
    ].join("\n"),
  );
  m.end();
  rec.finishTurn();
  out.add("live.jsonl", rec);

  return {
    scenario: {
      id: ID,
      session: {
        title: "Docs search page",
        cwd: CWD,
        projectDir: CWD,
        mode: "acceptEdits",
        model: "qwen3.8-27b-q8",
        effort: null,
      },
      storedEndedAgoMs: MINUTE,
      stored: "stored.jsonl",
      live: "live.jsonl",
      queuedBehind: "fix-split",
      branches: {},
      turns: [],
    },
    recordings: out.recordings,
    stats: out.stats,
  };
}
