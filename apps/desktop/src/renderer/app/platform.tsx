/**
 * Which platform the window runs on, from `bridge.platform.os`. Kept in React context (provided
 * once by main.tsx) rather than read from `getBridge()` inside components, so components render in
 * tests without a bridge. Outside Electron the value is "browser".
 */
import { createContext, type ReactNode, useContext } from "react";
import type { PlatformInfo } from "../../shared/bridge.ts";

export type PlatformOs = PlatformInfo["os"];

const PlatformContext = createContext<PlatformOs>("browser");

export function PlatformProvider(props: { os: PlatformOs; children?: ReactNode }) {
  return <PlatformContext.Provider value={props.os}>{props.children}</PlatformContext.Provider>;
}

export function usePlatformOs(): PlatformOs {
  return useContext(PlatformContext);
}

/**
 * Electron on macOS draws the traffic lights inside our title bar (titleBarStyle "hiddenInset"),
 * so the bar leaves room for them on the left.
 */
export function hasTrafficLights(os: PlatformOs): boolean {
  return os === "darwin";
}

/** True where ⌘ is the command key: macOS, or a browser running on a Mac. */
export function usesCommandKey(os: PlatformOs): boolean {
  if (os === "darwin") return true;
  if (os !== "browser" || typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.userAgent);
}
