/**
 * Where the app's own page lives, and the checks built on it: IPC is answered only for that
 * page's top frame, and windows never navigate anywhere else.
 */
import { pathToFileURL } from "node:url";

export type AppLocation =
  /** `electron-vite dev`: the renderer is served by Vite. */
  | { kind: "dev"; url: string }
  /** The built app: a file in `out/renderer`. */
  | { kind: "file"; path: string };

export function appLocation(devServerUrl: string | undefined, rendererFile: string): AppLocation {
  if (devServerUrl !== undefined && devServerUrl !== "") return { kind: "dev", url: devServerUrl };
  return { kind: "file", path: rendererFile };
}

/** What `BrowserWindow.loadURL` gets. */
export function appUrl(location: AppLocation): string {
  return location.kind === "dev" ? location.url : pathToFileURL(location.path).href;
}

/**
 * True when `url` is the app's page: the dev server's origin, or exactly the built index.html
 * (any query or hash). Anything unparsable is false.
 */
export function isAppUrl(url: string, location: AppLocation): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (location.kind === "dev") {
    const dev = new URL(location.url);
    return (
      parsed.origin === dev.origin && (parsed.protocol === "http:" || parsed.protocol === "https:")
    );
  }
  if (parsed.protocol !== "file:") return false;
  const expected = new URL(pathToFileURL(location.path).href);
  return parsed.pathname === expected.pathname && parsed.host === expected.host;
}

/** The parts of an IPC event the sender check needs (Electron's `IpcMainEvent` fits). */
export interface IpcSenderInfo {
  sender: { id: number; mainFrame: unknown };
  senderFrame: { url: string } | null;
}

/**
 * True when an IPC message comes from the top frame of one of the app's own windows showing the
 * app's page. Subframes, other web contents and navigated-away pages are refused.
 */
export function isTrustedSender(
  event: IpcSenderInfo,
  location: AppLocation,
  isOwnWebContents: (id: number) => boolean,
): boolean {
  const frame = event.senderFrame;
  if (!frame) return false;
  if (frame !== event.sender.mainFrame) return false;
  if (!isOwnWebContents(event.sender.id)) return false;
  return isAppUrl(frame.url, location);
}

/**
 * One log line saying why an IPC message was refused. The common harmless case gets its own
 * wording: a window's initial blank document, which exists before the app page commits and can
 * run the preload when a debugger attaches early (Playwright's does). The page itself asks again.
 */
export function describeRefusedSender(
  event: IpcSenderInfo,
  channel: string,
  isOwnWebContents: (id: number) => boolean,
): string {
  const frame = event.senderFrame;
  const prefix = `Refused "${channel}"`;
  if (!frame) return `${prefix}: the sending frame is gone (window closing or reloading).`;
  if (!isOwnWebContents(event.sender.id)) return `${prefix} from a page that is not an app window.`;
  if (frame !== event.sender.mainFrame)
    return `${prefix} from a subframe (${frame.url || "blank"}).`;
  if (frame.url === "") {
    return `${prefix} from window ${event.sender.id}'s initial blank document, before the app page loaded (harmless).`;
  }
  return `${prefix} from ${frame.url}, which is not the app page.`;
}
