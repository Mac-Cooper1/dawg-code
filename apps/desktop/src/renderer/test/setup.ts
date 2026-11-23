/**
 * Setup for component tests (jsdom). Adds the DOM matchers and the browser APIs jsdom lacks but
 * React components and Radix use.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  // The in-memory bridge persists settings to localStorage; keep tests independent.
  try {
    window.localStorage.clear();
  } catch {
    // Storage can be unavailable; nothing to clear then.
  }
});

if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

if (!("ResizeObserver" in window)) {
  Object.assign(window, { ResizeObserver: NoopObserver });
}
if (!("IntersectionObserver" in window)) {
  Object.assign(window, { IntersectionObserver: NoopObserver });
}

const elementProto = Element.prototype as unknown as Record<string, unknown>;
if (!elementProto.scrollIntoView) elementProto.scrollIntoView = () => {};
if (!elementProto.hasPointerCapture) elementProto.hasPointerCapture = () => false;
if (!elementProto.setPointerCapture) elementProto.setPointerCapture = () => {};
if (!elementProto.releasePointerCapture) elementProto.releasePointerCapture = () => {};
if (!elementProto.scrollTo) elementProto.scrollTo = () => {};
