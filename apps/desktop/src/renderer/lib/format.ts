/** Number, time and path formatting shared by the state layer and the UI. English, en-US. */

const numberFormat = new Intl.NumberFormat("en-US");

/** 18240 → "18,240". */
export function formatNumber(value: number): string {
  return numberFormat.format(Math.round(value));
}

/** Token counts for meters: 840 → "840", 74200 → "74.2K", 133000 → "133K", 1250000 → "1.3M". */
export function formatTokens(value: number): string {
  const n = Math.max(0, Math.round(value));
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trimZero((n / 1000).toFixed(1))}K`;
  return `${trimZero((n / 1_000_000).toFixed(1))}M`;
}

function trimZero(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/** 0.364 → "36%". */
export function formatPercent(fraction: number): string {
  return `${Math.round(Math.max(0, fraction) * 100)}%`;
}

/**
 * Durations as the transcript shows them: 900 → "0.9 s", 5000 → "5 s", 48200 → "48 s",
 * 72000 → "1 min 12 s", 120000 → "2 min", 3_900_000 → "1 h 5 min".
 */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 10_000) {
    const seconds = Math.round(safe / 100) / 10;
    return `${trimZero(seconds.toFixed(1))} s`;
  }
  const totalSeconds = Math.round(safe / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${totalMinutes} min` : `${totalMinutes} min ${seconds} s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const monthDayYear = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Sidebar times, in local time: under a minute "now", then "3m", "5h" (same day), "Yesterday",
 * a weekday within the last week ("Mon"), "Nov 3" this year, else "Nov 3, 2025".
 */
export function formatRelativeTime(time: number, now: number): string {
  const diff = now - time;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  const today = startOfDay(now);
  if (time >= today) return `${Math.floor(diff / 3_600_000)}h`;
  const day = 86_400_000;
  // Calendar days, robust to daylight-saving changes.
  const daysAgo = Math.round((today - startOfDay(time)) / day);
  if (daysAgo <= 1) return "Yesterday";
  if (daysAgo < 7) return weekday.format(time);
  if (new Date(time).getFullYear() === new Date(now).getFullYear()) return monthDay.format(time);
  return monthDayYear.format(time);
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** "/Users/me/code/tally" → "~/code/tally" when `homeDir` is "/Users/me". */
export function shortenPath(path: string, homeDir: string): string {
  const home = stripTrailingSlash(homeDir);
  if (home === "" || home === "/") return path;
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * A path relative to a base directory when it is inside it ("src/tally/money.py"), otherwise
 * shortened with "~".
 */
export function displayPath(path: string, base: string, homeDir: string): string {
  const root = stripTrailingSlash(base);
  if (root !== "" && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return shortenPath(path, homeDir);
}

/** The last path segment: "/a/b/money.py" → "money.py". */
export function basename(path: string): string {
  const trimmed = stripTrailingSlash(path);
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** Shortens text to `max` characters with an ellipsis. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
