/**
 * Side requests (session titles, WebFetch's page summaries) sent to a helper model when there is
 * one, and to the main model otherwise. A model provider hands the client this makes to a
 * session as `ModelConnection.utility.client` (with no pool: the routes schedule their own
 * slots), so the conversation's own slots, cache and compute stay with the conversation.
 *
 * - Each request asks `routes` where it may go, so a helper that starts, moves to another port
 *   after a restart, or is turned off is followed without reconnecting the session.
 * - A helper that fails before it starts answering (it cannot be reached, it answers with an
 *   error, or it sends nothing within `firstEventTimeoutMs`) is given up on for that request:
 *   the same request goes to the main model, and `onFallback` says why, so nothing waits on a
 *   helper that is down. Once the helper has started writing its answer, a failure is the
 *   caller's to handle, as with any request.
 * - `endpoint` is the helper's while there is one, so whoever sizes or shapes a side request
 *   (WebFetch's page to the window; the profile's template options) does it for the model that
 *   answers.
 */
import type { Endpoint } from "@dawg/models";
import {
  type ModelClient,
  ModelError,
  type ModelRequest,
  type ModelStreamEvent,
} from "../contracts/model.ts";
import { type SlotScheduler, scheduledClient } from "./slots.ts";

/** One place a side request can go. */
export interface SideRoute {
  client: ModelClient;
  /** The server's slots for side requests: one is taken before the request is sent. */
  scheduler?: SlotScheduler;
}

export interface SideRoutes {
  /** The helper, when there is one now; null sends the request to `main`. */
  helper: SideRoute | null;
  /** The main model's side slot (the bundled runtime), or its server. */
  main: SideRoute;
}

export interface SideClientOptions {
  /** Where a request may go, asked once per request. A rejection fails the request. */
  routes(signal?: AbortSignal): Promise<SideRoutes>;
  /** The endpoint side requests are sized and shaped for: the helper's while there is one. */
  endpoint(): Endpoint;
  /** A request meant for the helper went to the main model; `problem` says why. */
  onFallback?(problem: string): void;
  /**
   * How long the helper may take to send its first event (the bundled runtime reports prompt
   * progress at once) before the main model takes the request. Default 60 s: room to wake a
   * helper that was unloaded while idle.
   */
  firstEventTimeoutMs?: number;
}

export const SIDE_FIRST_EVENT_TIMEOUT_MS = 60_000;

/** The owner side requests take slots as: they keep no cache worth returning to. */
const SIDE_OWNER = "side";

export function sideClient(options: SideClientOptions): ModelClient {
  return {
    get endpoint() {
      return options.endpoint();
    },
    stream: (request) => streamSide(options, request),
    // Counting is for conversations; side requests are sized by characters.
    countTokens: async () => null,
  };
}

function onRoute(route: SideRoute, request: ModelRequest): AsyncIterable<ModelStreamEvent> {
  const client =
    route.scheduler === undefined
      ? route.client
      : scheduledClient(route.client, route.scheduler, { owner: SIDE_OWNER });
  // A slot named by the caller belongs to some other server; the route's scheduler picks one.
  const { slot: _slot, ...rest } = request;
  return client.stream(rest);
}

/** Events that are part of the answer itself, after which the request cannot move. */
function isAnswer(event: ModelStreamEvent): boolean {
  return event.type !== "prompt_progress";
}

async function* streamSide(
  options: SideClientOptions,
  request: ModelRequest,
): AsyncGenerator<ModelStreamEvent> {
  const { helper, main } = await options.routes(request.signal);
  if (helper !== null) {
    const timeoutMs = options.firstEventTimeoutMs ?? SIDE_FIRST_EVENT_TIMEOUT_MS;
    const giveUp = new AbortController();
    const signal =
      request.signal === undefined
        ? giveUp.signal
        : AbortSignal.any([request.signal, giveUp.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => giveUp.abort(),
      timeoutMs,
    );
    let answering = false;
    try {
      for await (const event of onRoute(helper, { ...request, signal })) {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (isAnswer(event)) answering = true;
        yield event;
      }
      return;
    } catch (error) {
      if (request.signal?.aborted === true || answering) throw error;
      const problem = giveUp.signal.aborted
        ? `no answer within ${Math.round(timeoutMs / 1000)} s`
        : error instanceof Error
          ? error.message
          : String(error);
      options.onFallback?.(problem);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  if (request.signal?.aborted === true) {
    throw new ModelError("aborted", "The request was stopped.");
  }
  yield* onRoute(main, request);
}
