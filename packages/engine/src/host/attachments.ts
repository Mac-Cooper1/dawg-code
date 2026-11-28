/**
 * Which connections hold which sessions, shared by every host serving the same engine (one
 * per window in the app). A session's capabilities are the union of its holders': if any window
 * can answer a permission prompt, prompts are raised. A session nobody holds may be left running
 * for a while ("orphaned") and is closed when it goes idle or its time runs out.
 */
import type { ClientCapabilities } from "@dawg/protocol";
import type { Engine } from "../runtime/engine.ts";
import type { SessionRuntime } from "../runtime/session.ts";

interface Orphan {
  timer: ReturnType<typeof setTimeout>;
}

export class Attachments {
  readonly #holders = new Map<string, Map<symbol, ClientCapabilities>>();
  readonly #orphans = new Map<string, Orphan>();

  holders(sessionId: string): number {
    return this.#holders.get(sessionId)?.size ?? 0;
  }

  attach(runtime: SessionRuntime, holder: symbol, capabilities: ClientCapabilities): void {
    let map = this.#holders.get(runtime.id);
    if (map === undefined) {
      map = new Map();
      this.#holders.set(runtime.id, map);
    }
    map.set(holder, capabilities);
    this.#adopt(runtime.id);
    runtime.setCapabilities(this.capabilities(runtime.id));
  }

  /** Returns how many holders remain. */
  detach(sessionId: string, holder: symbol): number {
    const map = this.#holders.get(sessionId);
    if (map === undefined) return 0;
    map.delete(holder);
    if (map.size === 0) this.#holders.delete(sessionId);
    return map.size;
  }

  /** The union of the holders' capabilities. */
  capabilities(sessionId: string): ClientCapabilities {
    const all = [...(this.#holders.get(sessionId)?.values() ?? [])];
    return {
      permissionPrompts: all.some((c) => c.permissionPrompts),
      questions: all.some((c) => c.questions),
      planApproval: all.some((c) => c.planApproval),
      elicitation: all.some((c) => c.elicitation),
    };
  }

  /**
   * Leaves a busy session nobody holds to finish its turn. It is closed when it goes idle, or
   * interrupted and closed after `graceMs`, unless a connection takes it back first.
   */
  orphan(runtime: SessionRuntime, graceMs: number): void {
    const id = runtime.id;
    this.#adopt(id);
    const closeIfOrphaned = () => {
      if (this.#orphans.get(id) !== orphan || this.holders(id) > 0) return;
      this.#adopt(id);
      void runtime.close().catch(() => {});
    };
    const timer = setTimeout(closeIfOrphaned, graceMs);
    // A waiting timer must not keep a process alive that has nothing else to do.
    timer.unref?.();
    const orphan: Orphan = { timer };
    this.#orphans.set(id, orphan);
    void runtime.waitForIdle().then(closeIfOrphaned, closeIfOrphaned);
  }

  isOrphaned(sessionId: string): boolean {
    return this.#orphans.has(sessionId);
  }

  #adopt(sessionId: string): void {
    const orphan = this.#orphans.get(sessionId);
    if (orphan === undefined) return;
    clearTimeout(orphan.timer);
    this.#orphans.delete(sessionId);
  }
}

const registry = new WeakMap<Engine, Attachments>();

export function attachmentsFor(engine: Engine): Attachments {
  let found = registry.get(engine);
  if (found === undefined) {
    found = new Attachments();
    registry.set(engine, found);
  }
  return found;
}
