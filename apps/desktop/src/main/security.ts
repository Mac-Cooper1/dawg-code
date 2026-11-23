/**
 * App-wide hardening, installed before the first window opens. The renderer is sandboxed and
 * shows only the app's own page: no new windows, no navigation elsewhere, no webviews, no
 * permissions, no requests to the network.
 */
import { app, type Session, session } from "electron";
import { type AppLocation, isAppUrl } from "./app-url.ts";

/**
 * `navigator.clipboard.writeText` (copy buttons on code blocks) needs this one. It only writes
 * plain text the page already has; reading the clipboard stays denied.
 */
const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

export function installSecurity(location: AppLocation, log: (message: string) => void): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      log(`Blocked a new window for ${url}`);
      return { action: "deny" };
    });
    const blockForeignNavigation = (event: { preventDefault(): void }, url: string) => {
      if (isAppUrl(url, location)) return;
      event.preventDefault();
      log(`Blocked navigation to ${url}`);
    };
    contents.on("will-navigate", blockForeignNavigation);
    contents.on("will-redirect", blockForeignNavigation);
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  restrictSession(session.defaultSession, location, log);
}

function restrictSession(target: Session, location: AppLocation, log: (message: string) => void) {
  target.setPermissionRequestHandler((contents, permission, callback) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission) && isAppUrl(contents.getURL(), location);
    if (!allowed) log(`Denied the "${permission}" permission`);
    callback(allowed);
  });
  target.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) =>
      ALLOWED_PERMISSIONS.has(permission) && isAllowedOrigin(requestingOrigin, location),
  );
  // No remote content: only the dev server (in dev) may be reached over the network.
  target.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, callback) => {
      const allowed = location.kind === "dev" && sameHost(details.url, location.url);
      if (!allowed) log(`Blocked a request to ${details.url}`);
      callback({ cancel: !allowed });
    },
  );
}

function isAllowedOrigin(origin: string, location: AppLocation): boolean {
  if (location.kind === "dev") return sameHost(origin, location.url);
  return origin === "file://" || origin.startsWith("file:");
}

function sameHost(url: string, devUrl: string): boolean {
  try {
    return new URL(url).host === new URL(devUrl).host;
  } catch {
    return false;
  }
}
