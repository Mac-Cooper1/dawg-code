/**
 * The performance budgets of Phase 3 (spec, "Accessibility and performance"), measured in the
 * built app on the mock engine with a synthetic session of 5,000 items
 * (`src/mock-engine/long-session.ts`) and a temporary git repository for the large diff:
 *
 * - the window is visible within 2 s of launch;
 * - a long session opens quickly: its newest items show promptly, the rest follow without a freeze;
 * - scrolling a 5,000-item transcript is smooth;
 * - streamed text reaches the transcript at most once per frame, and a delta re-renders only the
 *   part of the transcript that holds its item;
 * - a 5,000-line diff opens in the Changes pane without freezing the window.
 *
 * Along the way it checks that the long transcript still behaves: Jump to latest, selecting
 * across items, a decision record's "Show the card again", and opening a tool card without the
 * view jumping.
 *
 * Every number is printed ("[perf] …") and attached to the test. Budgets are set for GitHub's
 * Apple Silicon runners with headroom; README.md ("Performance") gives the measurements on the
 * reference Intel laptop before and after, and why each budget is what it is. With
 * PERF_PROFILE_DIR set, the open and the stream also write CPU profiles there and print where the
 * time went.
 *
 * Page-wide role queries compute every accessible name in the page, which takes seconds over a
 * long transcript, so measurements use plain selectors and in-page scripts.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  LONG_SESSION_FIRST_PROMPT,
  LONG_SESSION_LAST_ANSWER,
  LONG_SESSION_TITLE,
} from "../src/mock-engine/long-session.ts";

const appDir = path.resolve(import.meta.dirname, "..");
const ITEMS = 5_000;

/**
 * The budgets. The spec's 2 s for the window stands as it is; README.md ("Performance") explains
 * the others. In short: several times what the reference Intel laptop measures, well under what
 * the app measured before this work, and on clocks a slow CI runner keeps.
 */
const BUDGET = {
  /** From the app process's creation to the window showing (spec). */
  visibleMs: 2_000,
  /** From clicking a 5,000-item session to its newest items painted. Before: 2.5–8 s. */
  newestMs: 1_000,
  /** Longest main-thread task while it opens and draws the rest. Before: 1.9–6.4 s. */
  openTaskMs: 300,
  /** The whole session drawn, in the background. */
  allDrawnMs: 20_000,
  /** 95th percentile frame while scrolling and streaming: at most 1 frame in 20 late. */
  frameP95Ms: 25,
  /**
   * A stall while scrolling: a frame over 100 ms. At most 1 frame in 200 may stall. Not the single
   * worst frame: on CI's shared virtual machines one frame now and then waits on the host (a run
   * on GitHub's Apple Silicon runner had p95 21 ms and one 351 ms frame in 617), while the jank
   * this guards against stalls many frames (before this work, p95 alone was 34–161 ms).
   */
  stallMs: 100,
  stallsPerFrame: 1 / 200,
  /** From clicking a 5,000-line diff to its lines drawn, and the longest task meanwhile. */
  diffMs: 2_000,
  diffTaskMs: 300,
} as const;

let root: string;
let project: string;
let app: ElectronApplication;
let page: Page;
const mainLines: string[] = [];

// One retry on CI: timings on a shared virtual machine are noisy, and a retry relaunches the app
// and measures everything again. Locally, never.
test.describe.configure({ mode: "serial", timeout: 180_000, retries: process.env.CI ? 1 : 0 });

const LOG = '[role="log"][aria-label="Transcript"]';

function git(...args: string[]): string {
  return execFileSync("git", ["-C", project, ...args], { encoding: "utf8" });
}

function report(name: string, value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  console.log(`[perf] ${name}: ${text}`);
  test.info().annotations.push({ type: name, description: text });
}

/** With PERF_PROFILE_DIR set, records a CPU profile of `run` and prints where the time went. */
async function profiled<T>(name: string, run: () => Promise<T>): Promise<T> {
  const dir = process.env.PERF_PROFILE_DIR ?? "";
  if (dir === "") return run();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
  await cdp.send("Profiler.start");
  const result = await run();
  const { profile } = (await cdp.send("Profiler.stop")) as {
    profile: {
      nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[];
      samples: number[];
      timeDeltas: number[];
    };
  };
  await writeFile(path.join(dir, `${name}.cpuprofile`), JSON.stringify(profile));
  const self = new Map<number, number>();
  profile.samples.forEach((id, i) => {
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
  });
  const byName = new Map<string, number>();
  for (const node of profile.nodes) {
    const frame = node.callFrame;
    const key = `${frame.functionName || "(anonymous)"} ${frame.url.split("/").at(-1)}:${frame.lineNumber + 1}`;
    byName.set(key, (byName.get(key) ?? 0) + (self.get(node.id) ?? 0));
  }
  const top = [...byName].sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log(
    `[perf] profile ${name}:\n${top.map(([key, us]) => `  ${(us / 1000).toFixed(1)} ms  ${key}`).join("\n")}`,
  );
  await cdp.detach();
  return result;
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-perf-"));
  const home = path.join(root, "home");
  // The long session's folder (~/code/ledger), a git repository with a 6,000-line file.
  project = path.join(home, "code", "ledger");
  await mkdir(path.join(project, "src", "ledger"), { recursive: true });
  const lines = Array.from(
    { length: 6_000 },
    (_, i) => `export const value${i} = ${i}; // entry ${i}`,
  );
  await writeFile(path.join(project, "src", "ledger", "generated.ts"), `${lines.join("\n")}\n`);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "dawg e2e");
  git("config", "user.email", "e2e@example.invalid");
  git("add", ".");
  git("commit", "-q", "-m", "Start");

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  env.DAWG_HOME = path.join(root, "data");
  env.HOME = home;
  env.DAWG_ENGINE = "mock";
  // Recorded timing, so the streamed answer arrives as a fast model sends it.
  env.DAWG_MOCK_SPEED = "1";
  env.DAWG_MOCK_LONG_SESSION = String(ITEMS);

  app = await electron.launch({
    // A window behind others still gets its frames, so the numbers do not depend on what else
    // is on the screen.
    args: ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", appDir],
    cwd: appDir,
    env,
    timeout: 30_000,
  });
  app.process().stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.includes("[main]")) mainLines.push(line);
    }
  });
  page = await app.firstWindow();
  page.on("console", (message) => {
    if (message.text().startsWith("[perf]")) console.log(message.text());
  });
});

test.afterAll(async () => {
  await app?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

test("the window is visible within 2 s of launch", async () => {
  await expect.poll(() => mainLines.find((line) => line.includes("Window visible"))).toBeTruthy();
  const line = mainLines.find((entry) => entry.includes("Window visible")) ?? "";
  report("visible", line.replace(/^.*Window visible /, ""));
  const match = /(\d+) ms after the app started/.exec(line);
  expect(match, "main reports the time since the process started").not.toBeNull();
  expect(Number(match?.[1])).toBeLessThan(BUDGET.visibleMs);
});

test("a 5,000-item session shows its newest items promptly, then the rest without a freeze", async () => {
  const row = page.locator(`button[aria-label^="${LONG_SESSION_TITLE}"]`);
  await expect(row).toBeVisible();
  // Let the start settle (sessions listed, live recordings playing) before measuring.
  await page.waitForTimeout(1_500);
  const result = await profiled("open", () =>
    page.evaluate(
      async ({ log, title, last, first, allDrawnMs }) => {
        const tasks: number[] = [];
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) tasks.push(entry.duration);
        });
        observer.observe({ type: "longtask" });
        const button = document.querySelector(`button[aria-label^="${title}"]`) as HTMLElement;
        const start = performance.now();
        button.click();
        const column = () => document.querySelector(log)?.firstElementChild ?? null;
        // The newest answer, inside the visible part of the transcript.
        await new Promise<void>((resolve) => {
          const check = () => {
            const scroller = document.querySelector(log);
            const answer = [...(scroller?.querySelectorAll("p") ?? [])].find((p) =>
              (p.textContent ?? "").startsWith(last),
            );
            if (scroller && answer) {
              const box = answer.getBoundingClientRect();
              const view = scroller.getBoundingClientRect();
              if (box.bottom > view.top && box.top < view.bottom) {
                resolve();
                return;
              }
            }
            requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        });
        // Painted: the frame after it is in the page.
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const newest = performance.now() - start;
        // Then the oldest item, drawn in the background.
        await new Promise<void>((resolve) => {
          const check = () => {
            const text = column()?.firstElementChild?.textContent ?? "";
            if (text.includes(first) || performance.now() - start > allDrawnMs) {
              resolve();
              return;
            }
            setTimeout(check, 50);
          };
          check();
        });
        const all = performance.now() - start;
        observer.disconnect();
        return {
          newestMs: Math.round(newest),
          allMs: Math.round(all),
          longestTaskMs: Math.round(Math.max(0, ...tasks)),
          longTasks: tasks.length,
          nodes: document.querySelector(log)?.querySelectorAll("*").length ?? 0,
        };
      },
      {
        log: LOG,
        title: LONG_SESSION_TITLE,
        last: LONG_SESSION_LAST_ANSWER,
        first: LONG_SESSION_FIRST_PROMPT,
        allDrawnMs: BUDGET.allDrawnMs,
      },
    ),
  );
  report("open", result);
  expect(result.newestMs).toBeLessThan(BUDGET.newestMs);
  expect(result.longestTaskMs).toBeLessThan(BUDGET.openTaskMs);
  expect(result.allMs).toBeLessThan(BUDGET.allDrawnMs);
});

test("scrolling the 5,000-item transcript is smooth", async () => {
  // Up from the newest items, then from the middle, then down from the top: 3,600 px/s.
  const { intervals, tasks } = await page.evaluate(async (log) => {
    const scroller = document.querySelector(log) as HTMLElement;
    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    observer.observe({ type: "longtask" });
    const gaps: number[] = [];
    const run = async (frames: number, step: number) => {
      let last = performance.now();
      for (let frame = 0; frame < frames; frame++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const now = performance.now();
        if (frame > 0) gaps.push(now - last);
        last = now;
        scroller.scrollTop = Math.max(0, scroller.scrollTop - step);
      }
    };
    scroller.scrollTop = scroller.scrollHeight;
    await run(300, 60);
    scroller.scrollTop = scroller.scrollHeight / 2;
    await run(200, 60);
    scroller.scrollTop = 0;
    await run(120, -60);
    observer.disconnect();
    return { intervals: gaps, tasks: longTasks };
  }, LOG);
  const sorted = [...intervals].sort((a, b) => a - b);
  const stats = {
    frames: sorted.length,
    p50: Math.round(sorted[Math.floor(sorted.length * 0.5)] ?? 0),
    p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    max: Math.round(sorted.at(-1) ?? 0),
    late: sorted.filter((interval) => interval > 33.4).length,
    stalls: sorted.filter((interval) => interval > BUDGET.stallMs).length,
    longestTask: Math.round(Math.max(0, ...tasks)),
  };
  report("scroll", stats);
  expect(stats.p95).toBeLessThan(BUDGET.frameP95Ms);
  expect(stats.stalls).toBeLessThanOrEqual(
    Math.max(1, Math.floor(stats.frames * BUDGET.stallsPerFrame)),
  );
});

test("the long transcript still jumps to the latest, selects across items, shows a card again and opens a call in place", async () => {
  const log = page.locator(LOG);
  // Scrolled up: Jump to latest shows and brings the newest items back.
  await page.evaluate((selector) => {
    const scroller = document.querySelector(selector) as HTMLElement;
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
    scroller.scrollTop = scroller.scrollHeight / 3;
  }, LOG);
  const jump = page.locator("button", { hasText: "Jump to latest" });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(jump).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate((selector) => {
        const scroller = document.querySelector(selector) as HTMLElement;
        return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      }, LOG),
    )
    .toBeLessThan(40);

  // A selection from one item into the next, across two groups deep in the history, holds both.
  const selected = await page.evaluate((selector) => {
    const scroller = document.querySelector(selector) as HTMLElement;
    const groups = scroller.firstElementChild?.children ?? [];
    const from = groups[10]?.lastElementChild;
    const to = groups[11]?.firstElementChild;
    if (!from || !to) return null;
    from.scrollIntoView();
    const range = document.createRange();
    range.setStartBefore(from);
    range.setEndAfter(to);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const text = selection?.toString() ?? "";
    selection?.removeAllRanges();
    return { text, from: from.textContent ?? "", to: to.textContent ?? "" };
  }, LOG);
  expect(selected).not.toBeNull();
  const start = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 12);
  const copied = (selected?.text ?? "").replace(/\s+/g, " ");
  expect(copied).toContain(start(selected?.from ?? ""));
  expect(copied).toContain(start(selected?.to ?? ""));

  // An answered decision far up the session: its card comes back, and goes again.
  const again = log.locator("button", { hasText: "Show the card again" }).first();
  await again.scrollIntoViewIfNeeded();
  await again.click();
  const hide = log.locator("button", { hasText: "Hide the card" });
  await expect(hide.first()).toBeVisible();
  await hide.first().click();
  await expect(hide).toHaveCount(0);

  // Opening a tool call keeps its header where it was on screen. (A handle, since the selector
  // stops matching it once it is open.)
  const header = await log.locator('button[aria-expanded="false"]').nth(40).elementHandle();
  if (!header) throw new Error("No closed tool call in the transcript");
  await header.scrollIntoViewIfNeeded();
  const before = await header.boundingBox();
  await header.click();
  await expect.poll(() => header.getAttribute("aria-expanded")).toBe("true");
  const after = await header.boundingBox();
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(2);
});

test("streamed text reaches the long transcript once per frame, touching one part of it", async () => {
  await page.evaluate((selector) => {
    const scroller = document.querySelector(selector) as HTMLElement;
    scroller.scrollTop = scroller.scrollHeight;
    const column = scroller.firstElementChild as HTMLElement;
    const state = {
      commits: 0,
      touched: new Set<Element>(),
      frames: [] as { interval: number; commits: number; touched: number }[],
      tasks: [] as number[],
      running: true,
    };
    (window as unknown as { perfStream: typeof state }).perfStream = state;
    // A commit's changes arrive as one batch of mutation records; each record is traced to the
    // part of the transcript (a group of items) it changed.
    new MutationObserver((records) => {
      state.commits += 1;
      for (const record of records) {
        let node: Node | null = record.target;
        while (node && node.parentNode !== column) node = node.parentNode;
        if (node) state.touched.add(node as Element);
      }
    }).observe(column, { subtree: true, childList: true, characterData: true, attributes: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.tasks.push(entry.duration);
    }).observe({ type: "longtask" });
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      state.frames.push({
        interval: now - last,
        commits: state.commits,
        touched: state.touched.size,
      });
      state.commits = 0;
      state.touched.clear();
      last = now;
      if (state.running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, LOG);

  const composer = page.locator('[aria-label="Message to dawg"]');
  await composer.fill("Summarise the day's work.");
  const stop = '[aria-label="Stop, or press Esc"]';
  await profiled("stream", async () => {
    await composer.press("Enter");
    await page.waitForFunction((s) => document.querySelector(s) !== null, stop, { polling: 100 });
    await page.waitForFunction((s) => document.querySelector(s) === null, stop, {
      polling: 100,
      timeout: 60_000,
    });
  });
  const result = await page.evaluate(() => {
    const state = (
      window as unknown as {
        perfStream: {
          frames: { interval: number; commits: number; touched: number }[];
          tasks: number[];
          running: boolean;
        };
      }
    ).perfStream;
    state.running = false;
    const frames = state.frames.slice(1);
    const sorted = frames.map((frame) => frame.interval).sort((a, b) => a - b);
    return {
      frames: frames.length,
      framesWithCommits: frames.filter((frame) => frame.commits > 0).length,
      mostCommitsInAFrame: Math.max(...frames.map((frame) => frame.commits)),
      mostPartsTouchedInAFrame: Math.max(...frames.map((frame) => frame.touched)),
      p50: Math.round(sorted[Math.floor(sorted.length * 0.5)] ?? 0),
      p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      max: Math.round(sorted.at(-1) ?? 0),
      longestTask: Math.round(Math.max(0, ...state.tasks)),
    };
  });
  report("stream", result);
  // The answer streamed over many frames, each drawn by one commit at most.
  expect(result.framesWithCommits).toBeGreaterThan(30);
  expect(result.mostCommitsInAFrame).toBe(1);
  // A delta changes the group holding its item (a new item may start the next group).
  expect(result.mostPartsTouchedInAFrame).toBeLessThanOrEqual(2);
  expect(result.p95).toBeLessThan(BUDGET.frameP95Ms);
});

test("a 5,000-line diff opens in Changes without freezing the window", async () => {
  // A small change first, so Monaco has loaded before the measurement.
  await writeFile(path.join(project, "notes.md"), "# Notes\n\nA small change.\n");
  await page
    .locator('[aria-label="Side panes"]')
    .first()
    .locator("button", { hasText: "Changes" })
    .first()
    .click();
  const list = page.locator('[aria-label="Changed files"]');
  await list.locator("button", { hasText: "notes.md" }).click();
  await expect(page.locator(".monaco-diff-editor .view-line").first()).toBeVisible({
    timeout: 30_000,
  });

  // Five lines of every six change: 5,000 changed lines in 1,000 hunks. Written whole, then
  // moved into place, so the watcher never sees half a file.
  const lines = Array.from({ length: 6_000 }, (_, i) =>
    i % 6 === 5
      ? `export const value${i} = ${i}; // entry ${i}`
      : `export const value${i} = ${i * 2}; // doubled`,
  );
  const target = path.join(project, "src", "ledger", "generated.ts");
  await writeFile(`${target}.tmp`, `${lines.join("\n")}\n`);
  await rename(`${target}.tmp`, target);
  const file = list.locator("button", { hasText: "src/ledger/generated.ts" });
  await expect(file).toBeVisible({ timeout: 30_000 });
  await expect(file).toContainText("5000");
  const result = await page.evaluate(
    async ({ button, budget }) => {
      const tasks: number[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) tasks.push(entry.duration);
      });
      observer.observe({ type: "longtask" });
      const intervals: number[] = [];
      let last = performance.now();
      let running = true;
      const tick = () => {
        const now = performance.now();
        intervals.push(now - last);
        last = now;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const start = performance.now();
      (button as HTMLElement).click();
      let shown = Number.POSITIVE_INFINITY;
      await new Promise<void>((resolve) => {
        const check = () => {
          const drawn = document.querySelectorAll(
            ".monaco-diff-editor .editor.modified .view-line",
          );
          if (drawn.length > 5 && (drawn[0]?.textContent ?? "").includes("value")) {
            shown = performance.now() - start;
            resolve();
          } else if (performance.now() - start > budget * 5) resolve();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      });
      // Monaco keeps working on the diff for a moment after the first lines show.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      running = false;
      observer.disconnect();
      return {
        shownMs: Math.round(shown),
        longestTaskMs: Math.round(Math.max(0, ...tasks)),
        longestFrameMs: Math.round(Math.max(0, ...intervals)),
      };
    },
    { button: await file.elementHandle(), budget: BUDGET.diffMs },
  );
  report("diff", result);
  expect(result.shownMs).toBeLessThan(BUDGET.diffMs);
  expect(result.longestTaskMs).toBeLessThan(BUDGET.diffTaskMs);
});
