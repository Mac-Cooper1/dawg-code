/** Window sizes and colours that do not need Electron to compute. */
import type { ResolvedTheme } from "../shared/bridge.ts";

export const DEFAULT_WINDOW_SIZE = { width: 1440, height: 900 } as const;
export const MIN_WINDOW_SIZE = { width: 960, height: 600 } as const;

/**
 * Traffic lights for the 46 px title bar the renderer draws: 14 px from the left like the
 * mockup's padding, and vertically centred (the buttons are about 14 px tall, so 46 − 14 = 32,
 * halved is 16; 15 sits them on the bar's optical centre above its 1 px bottom line).
 */
export const TRAFFIC_LIGHT_POSITION = { x: 14, y: 15 } as const;

/** The window background behind the page, so resizing and first paint never flash white. */
export const WINDOW_BACKGROUND: Record<ResolvedTheme, string> = {
  dark: "#131416",
  light: "#F7F7F4",
};

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The default window size, shrunk to fit the screen's work area, centred in it. */
export function initialBounds(workArea: Rectangle): Rectangle {
  const width = Math.min(DEFAULT_WINDOW_SIZE.width, workArea.width);
  const height = Math.min(DEFAULT_WINDOW_SIZE.height, workArea.height);
  return {
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
  };
}
