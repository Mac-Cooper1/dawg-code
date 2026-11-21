/**
 * `createEngine`: an engine with the real prompt assembler, compactor and token estimator filled
 * in, for hosts (the command-line tool, the protocol server) that do not need to swap them.
 */
import { createCompactor, createTokenEstimator } from "../context/index.ts";
import { getModelProfile } from "../profiles/index.ts";
import { createPromptAssembler } from "../prompt/index.ts";
import { Engine } from "./engine.ts";
import type { EngineOptions } from "./types.ts";

type Replaceable = "assembler" | "compactor" | "estimator" | "profile";

export type CreateEngineOptions = Omit<EngineOptions, Replaceable> &
  Partial<Pick<EngineOptions, Replaceable>>;

/**
 * Like `new Engine(options)`, with defaults for the prompt parts. `profile` defaults to the
 * default model profile; a host that knows each model's catalog entry should pass
 * `(endpoint) => getModelProfile(profileIdFor(endpoint))`.
 */
export function createEngine(options: CreateEngineOptions): Engine {
  const estimator = options.estimator ?? createTokenEstimator();
  return new Engine({
    ...options,
    assembler: options.assembler ?? createPromptAssembler(),
    estimator,
    compactor: options.compactor ?? createCompactor({ estimator }),
    profile: options.profile ?? getModelProfile(null),
  });
}
