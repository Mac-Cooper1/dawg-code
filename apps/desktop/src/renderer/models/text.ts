/**
 * The words the model screens use for catalog entries, downloads and installed models, shared
 * by the first-run screens and Settings → Models.
 */
import type {
  CatalogModel,
  DownloadState,
  MachineInfo,
  ModelOption,
  ServerInfo,
} from "../../shared/bridge.ts";
import {
  formatBytes,
  formatMemory,
  formatNumber,
  formatSpeed,
  formatTimeLeft,
  formatTokens,
} from "../lib/format.ts";

/** What it can do, as a sentence: "It uses tools, reads images and thinks before it answers." */
export function abilitySentence(entry: CatalogModel): string {
  const list: string[] = [];
  if (entry.capabilities.tools) list.push("uses tools");
  if (entry.capabilities.vision) list.push("reads images");
  if (entry.capabilities.reasoning) list.push("thinks before it answers");
  if (list.length === 0) return "";
  const last = list.pop();
  return list.length === 0 ? `It ${last}.` : `It ${list.join(", ")} and ${last}.`;
}

/** A context size in short: 131072 → "128K", 204800 → "200K", 100000 → "100K". */
export function shortContext(tokens: number): string {
  return tokens % 1024 === 0 ? `${tokens / 1024}K` : formatTokens(tokens);
}

/** "30.0 GB · needs 43 GB of memory · Apache-2.0 · 200K tokens · reads images". */
export function catalogFacts(entry: CatalogModel): string {
  return [
    formatBytes(entry.sizeBytes),
    `needs ${formatMemory(entry.memoryBytes)} of memory`,
    entry.licence.spdx,
    `${shortContext(entry.context.default)} tokens`,
    entry.capabilities.vision ? "reads images" : "text only",
  ].join(" · ");
}

/** "204,800 tokens". */
export function contextLine(entry: CatalogModel): string {
  return `${formatNumber(entry.context.default)} tokens`;
}

/** The share of a download on disk, 0–1. */
export function downloadFraction(download: DownloadState): number {
  if (download.phase === "done") return 1;
  if (download.bytesTotal <= 0) return 0;
  return Math.min(1, Math.max(0, download.bytesDone / download.bytesTotal));
}

/** "41.3%". */
export function downloadPercent(download: DownloadState): string {
  return `${(downloadFraction(download) * 100).toFixed(1)}%`;
}

/** "12.4 of 30.0 GB". */
function bytesOf(download: DownloadState): string {
  const total = formatBytes(download.bytesTotal);
  const done = formatBytes(download.bytesDone);
  // "12.4 of 30.0 GB" rather than "12.4 GB of 30.0 GB" when the units agree.
  const unit = total.split(" ")[1];
  return done.endsWith(` ${unit}`) ? `${done.split(" ")[0]} of ${total}` : `${done} of ${total}`;
}

/** One line on where a download stands. */
export function downloadLine(download: DownloadState): string {
  switch (download.phase) {
    case "queued":
      return "Waiting for another download to finish";
    case "checking":
      return "Checking the free space";
    case "downloading": {
      const parts = [bytesOf(download)];
      if (download.bytesPerSecond > 0) parts.push(formatSpeed(download.bytesPerSecond));
      if (download.secondsLeft !== null) parts.push(formatTimeLeft(download.secondsLeft));
      return parts.join(" · ");
    }
    case "verifying":
      return "Checking the download against its SHA-256";
    case "paused":
      return `Paused at ${bytesOf(download)} · resumes where it stopped`;
    case "done":
      return "Downloaded and checked";
    case "failed":
      return download.error ?? "The download failed.";
    case "cancelled":
      return "Cancelled";
  }
}

/**
 * What VoiceOver hears about a download, in a live region: the phase, and while it downloads the
 * progress in steps of ten percent, so the bytes and speed that change every second are not read
 * out each time. A failure is announced by its own alert.
 */
export function downloadAnnouncement(download: DownloadState): string {
  const percent = Math.floor(downloadFraction(download) * 100);
  switch (download.phase) {
    case "queued":
      return "Download queued";
    case "checking":
      return "Download starting";
    case "downloading":
      return `Downloading, ${Math.floor(percent / 10) * 10}% done`;
    case "verifying":
      return "Download complete, checking it";
    case "paused":
      return `Download paused at ${percent}%`;
    case "done":
      return "Download finished";
    case "failed":
      return "";
    case "cancelled":
      return "Download cancelled";
  }
}

/** "Apple silicon" or "Intel". */
export function archName(machine: MachineInfo): string {
  return machine.arch === "arm64" ? "Apple silicon" : "Intel";
}

const ORIGIN_TAGS: Record<ModelOption["origin"], string> = {
  catalog: "Downloaded by dawg",
  file: "Model file",
  lmstudio: "Found in LM Studio",
  ollama: "In Ollama",
  remote: "On a server",
};

/** Where an installed model comes from, as a tag. */
export function originTag(option: ModelOption): string {
  return ORIGIN_TAGS[option.origin];
}

/** "localhost:11434 · 3 models". */
export function serverFacts(server: ServerInfo): string {
  let shown = server.url;
  try {
    shown = new URL(server.url).host || server.url;
  } catch {
    // Shown as given.
  }
  const count = server.modelIds.length;
  const models = server.reachable ? [`${count} ${count === 1 ? "model" : "models"}`] : [];
  return [shown, ...models].join(" · ");
}
