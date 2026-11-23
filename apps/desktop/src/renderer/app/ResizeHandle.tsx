import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import styles from "./ResizeHandle.module.css";

export interface ResizeHandleProps {
  /** Accessible name: "Resize the sidebar". */
  label: string;
  /** The width of the panel this handle resizes. */
  value: number;
  min: number;
  max: number;
  /** Restored by a double click. */
  defaultValue: number;
  /**
   * Which edge of its panel the handle sits on. On the sidebar's right edge, dragging right
   * widens; on the dock's left edge, dragging left widens.
   */
  edge: "right" | "left";
  onChange(width: number): void;
}

/** Arrow keys move the edge by this much; with Shift, by `BIG_STEP`. */
const STEP = 16;
const BIG_STEP = 64;

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}

/**
 * A focusable vertical separator between two columns (the WAI-ARIA window splitter): drag it, or
 * focus it and use the arrow keys (Shift for bigger steps), Home and End.
 */
export function ResizeHandle(props: ResizeHandleProps) {
  const drag = useRef<{ startX: number; startValue: number } | null>(null);
  const direction = props.edge === "right" ? 1 : -1;

  const set = (width: number) => {
    const next = clamp(width, props.min, props.max);
    if (next !== props.value) props.onChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    // Arrows move the edge itself, so their effect on the width depends on the side.
    if (event.key === "ArrowRight") set(props.value + step * direction);
    else if (event.key === "ArrowLeft") set(props.value - step * direction);
    else if (event.key === "Home") set(props.min);
    else if (event.key === "End") set(props.max);
    else return;
    event.preventDefault();
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startValue: props.value };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    set(start.startValue + (event.clientX - start.startX) * direction);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: <hr> cannot take focus or pointer handlers; this is the ARIA window-splitter pattern
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuenow={props.value}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabIndex={0}
      className={styles.handle}
      data-edge={props.edge}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => set(props.defaultValue)}
    />
  );
}
