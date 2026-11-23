import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Within this many pixels of the bottom counts as "at the bottom". */
export const BOTTOM_SLACK_PX = 32;

export function isAtBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK_PX;
}

/**
 * Keeps a scrolling transcript pinned to its newest output until the person scrolls up, then
 * offers a way back. Works from scroll positions alone (`scrollTop`, `scrollHeight`), so it
 * behaves the same in tests with mocked sizes.
 *
 * - After every render, and whenever the content's size changes (a card opens, an image loads),
 *   the view jumps to the bottom while following.
 * - Scrolling up stops following; scrolling back to the bottom resumes it.
 * - `jumpToLatest` scrolls down (smoothly unless reduced motion is on) and resumes following.
 */
export function useFollowOutput(
  scroller: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  options: { reducedMotion: boolean; resetKey: string },
) {
  const following = useRef(true);
  /** A smooth scroll is on its way down: positions above the bottom are not the person's. */
  const jumping = useRef(false);
  const [showJump, setShowJump] = useState(false);

  const scrollToEnd = useCallback(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [scroller]);

  // A different session starts at its newest output.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets when the key changes
  useLayoutEffect(() => {
    following.current = true;
    jumping.current = false;
    setShowJump(false);
  }, [options.resetKey]);

  // After every render of the transcript.
  useLayoutEffect(() => {
    if (following.current) scrollToEnd();
  });

  // Size changes that happen inside memoised items, without a render of the transcript.
  useEffect(() => {
    const element = content.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current && !jumping.current) scrollToEnd();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [content, scrollToEnd]);

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const bottom = isAtBottom(element);
    if (jumping.current) {
      if (!bottom) return;
      jumping.current = false;
    }
    following.current = bottom;
    setShowJump(!bottom);
  }, [scroller]);

  /** Scrolling up with the wheel stops following at once, before the scroll event arrives. */
  const onWheel = useCallback((event: { deltaY: number }) => {
    if (event.deltaY < 0) {
      jumping.current = false;
      following.current = false;
    }
  }, []);

  const jumpToLatest = useCallback(() => {
    following.current = true;
    setShowJump(false);
    const element = scroller.current;
    if (!element) return;
    if (options.reducedMotion || typeof element.scrollTo !== "function") {
      element.scrollTop = element.scrollHeight;
      return;
    }
    jumping.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [scroller, options.reducedMotion]);

  return { showJump, onScroll, onWheel, jumpToLatest };
}
