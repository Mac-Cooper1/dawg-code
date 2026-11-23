import type { ReactNode } from "react";
import { hasTrafficLights, usePlatformOs } from "./platform.tsx";
import styles from "./TitleBar.module.css";

/**
 * The 46 px bar across the top of every window view. The window has no native title bar, so this
 * bar is the drag region; every control inside opts out (see TitleBar.module.css). In Electron on
 * macOS the traffic lights sit at its left edge, so it leaves room for them.
 */
export function TitleBarFrame(props: { children: ReactNode }) {
  const os = usePlatformOs();
  return (
    <header className={styles.bar} data-traffic-lights={hasTrafficLights(os) ? "true" : undefined}>
      {props.children}
    </header>
  );
}
