/**
 * A hook's work against its timeout: whatever a handler waits on (a model, a subagent, an MCP
 * server) may not stop when asked, so the hook stops waiting for it instead.
 */

/** `work`, or a rejection as soon as `signal` aborts, whichever comes first. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(new Error("stopped"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("stopped"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
