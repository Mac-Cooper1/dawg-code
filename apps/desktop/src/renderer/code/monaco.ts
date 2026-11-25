/**
 * Loads Monaco on first use. The import is dynamic, so Monaco and its worker are separate files
 * that the window fetches only when a pane first shows code.
 */
import { useEffect, useState } from "react";

export type Monaco = typeof import("monaco-editor/editor/editor.api.js");

let loading: Promise<Monaco> | null = null;

export function loadMonaco(): Promise<Monaco> {
  loading ??= import("./monaco-setup.ts").then((module) => module.monaco);
  // A failed load can be tried again.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

export type MonacoState =
  | { status: "loading" }
  | { status: "ready"; monaco: Monaco }
  | { status: "failed"; message: string };

/** Monaco, once it has loaded. */
export function useMonaco(): MonacoState {
  const [state, setState] = useState<MonacoState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    loadMonaco().then(
      (monaco) => {
        if (live) setState({ status: "ready", monaco });
      },
      (error: unknown) => {
        console.error("dawg-code: the code editor did not load", error);
        const message = error instanceof Error ? error.message : String(error);
        if (live) setState({ status: "failed", message });
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/** True when the person asked macOS to reduce motion. */
export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}
