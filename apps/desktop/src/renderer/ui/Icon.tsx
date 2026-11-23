/**
 * The icon set, drawn on a 16-unit grid with 1.5-unit round strokes (from the approved mockup).
 * Icons are decorative: give the control around them an accessible name instead.
 */
import type { ReactElement } from "react";

const ICONS = {
  sidebar: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M6 3v10" />
    </>
  ),
  folder: (
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  ),
  branch: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" />
    </>
  ),
  fork: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="11.5" cy="3.5" r="1.5" />
      <circle cx="8" cy="12.5" r="1.5" />
      <path d="M4.5 5c0 3 3.5 3 3.5 6M11.5 5c0 3-3.5 3-3.5 6" />
    </>
  ),
  changes: <path d="M5 2.5v6M2 5.5h6M8.5 12.5h5.5" />,
  file: (
    <>
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </>
  ),
  terminal: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M5 6.5l2 1.5-2 1.5M8.5 10H11" />
    </>
  ),
  plan: (
    <>
      <rect x="3" y="2" width="10" height="12" rx="1.5" />
      <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
    </>
  ),
  tasks: <path d="M2 4l1.5 1.5L6 3M2 10l1.5 1.5L6 9M8.5 4.5H14M8.5 10.5H14" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
    </>
  ),
  moon: <path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1z" />,
  plus: <path d="M8 3v10M3 8h10" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </>
  ),
  settings: (
    <>
      <path d="M2.5 4.5h11M2.5 11.5h11" />
      <circle cx="6" cy="4.5" r="1.8" />
      <circle cx="10.5" cy="11.5" r="1.8" />
    </>
  ),
  "chevron-right": <path d="M6 4l4 4-4 4" />,
  "chevron-down": <path d="M4 6l4 4 4-4" />,
  read: (
    <path d="M2 3.5h4A2 2 0 0 1 8 5.5V13a1.5 1.5 0 0 0-1.5-1.5H2zM14 3.5h-4A2 2 0 0 0 8 5.5V13a1.5 1.5 0 0 1 1.5-1.5H14z" />
  ),
  edit: <path d="M10.5 2.5l3 3L6 13H3v-3z" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  shield: <path d="M8 1.8l5 2v4c0 3.2-2.2 5.3-5 6.4C5.2 13.1 3 11 3 7.8v-4z" />,
  model: (
    <>
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
      <path d="M6 1.5V4M10 1.5V4M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5" />
    </>
  ),
  stop: <rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor" stroke="none" />,
  send: <path d="M8 13V3M4 7l4-4 4 4" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  question: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.3 6.2a1.8 1.8 0 1 1 3 1.3c-.7.4-1.3.8-1.3 1.7M8 11.3v.2" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  server: (
    <>
      <rect x="2" y="2.5" width="12" height="4.5" rx="1" />
      <rect x="2" y="9" width="12" height="4.5" rx="1" />
    </>
  ),
  download: <path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M3 13.5h10" />,
  more: (
    <>
      <circle cx="4" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2.2l6 10.8H2z" />
      <path d="M8 6.5v3M8 11.3v.2" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.8 1.7 2.7 3.7 2.7 6S9.8 12.3 8 14M8 2C6.2 3.7 5.3 5.7 5.3 8s.9 4.3 2.7 6" />
    </>
  ),
  external: <path d="M9 3h4v4M13 3L7.5 8.5M12 9.5V13H3V4h3.5" />,
  archive: (
    <>
      <rect x="2" y="3" width="12" height="3.5" rx="1" />
      <path d="M3 6.5V13h10V6.5M6.5 9h3" />
    </>
  ),
  compact: <path d="M5 2.5v3H2M11 2.5v3h3M5 13.5v-3H2M11 13.5v-3h3" />,
  image: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <circle cx="6" cy="6.5" r="1.3" />
      <path d="M14 10.5l-3.5-3.5L4 13" />
    </>
  ),
  unread: <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />,
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof ICONS;

export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export interface IconProps {
  name: IconName;
  /** Rendered size in pixels. Default 16. */
  size?: 12 | 14 | 16 | 20;
  className?: string;
  /** Stroke width on the 16-unit grid. Default 1.5. */
  strokeWidth?: number;
}

export function Icon({ name, size = 16, className, strokeWidth = 1.5 }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "none" }}
    >
      {ICONS[name]}
    </svg>
  );
}

/** The placeholder paw mark (see Open questions in the Phase 3 spec). 24-unit grid. */
export function LogoMark({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="currentColor">
      <ellipse cx="12" cy="15.5" rx="5" ry="4" />
      <circle cx="6" cy="9.5" r="2" />
      <circle cx="10" cy="6" r="2" />
      <circle cx="14" cy="6" r="2" />
      <circle cx="18" cy="9.5" r="2" />
    </svg>
  );
}
