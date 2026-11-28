/**
 * Picks a session's model profile (sampling, output cap, compaction threshold). A catalog model's
 * grant names its profile; when it names none, or one this engine does not have, the profile is
 * picked by model family, as the command-line tool does (packages/cli/src/profiles.ts): from the
 * model id ("qwen3.8-27b-q8", "ollama/qwen3.8:27b"), else from the server's own name for the
 * model (a file added by hand is named after the file).
 */
import { getModelProfile, hasModelProfile, type ModelProfile } from "@dawg/engine";

const FAMILIES: [RegExp, string][] = [
  [/qwen3\.8/, "qwen3.8"],
  [/qwen3\.6/, "qwen3.6"],
  [/laguna[-_. ]?xs[-_. ]?2\.1/, "laguna-xs-2.1"],
  [/gpt-oss/, "gpt-oss"],
  // The catalog's helper model, which answers side requests (titles, page summaries).
  [/minicpm5/, "minicpm5"],
];

/** The profile id for a model name, or null (the default profile). Only the last path part counts. */
export function profileIdForModel(name: string): string | null {
  const last = (name.split("/").at(-1) ?? name).toLowerCase();
  for (const [pattern, id] of FAMILIES) {
    if (pattern.test(last) && hasModelProfile(id)) return id;
  }
  return null;
}

export interface ProfileHints {
  /** The session's model id. */
  modelId: string;
  /** The server's own name for the model, when known. */
  serverName: string | null;
  /** The profile main's grant named (a catalog model's), when it named one. */
  catalogProfile: string | null;
}

/** The profile id for a model, or null for the default profile. */
export function profileIdFor(hints: ProfileHints): string | null {
  if (hints.catalogProfile !== null && hasModelProfile(hints.catalogProfile)) {
    return hints.catalogProfile;
  }
  return (
    profileIdForModel(hints.modelId) ??
    (hints.serverName === null ? null : profileIdForModel(hints.serverName))
  );
}

export function profileFor(hints: ProfileHints): ModelProfile {
  return getModelProfile(profileIdFor(hints));
}
