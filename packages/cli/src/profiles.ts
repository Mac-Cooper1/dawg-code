/** Picks the model profile from a model id, by family name. */
import { hasModelProfile } from "@dawg/engine";

const FAMILIES: [RegExp, string][] = [
  [/qwen3\.8/, "qwen3.8"],
  [/qwen3\.6/, "qwen3.6"],
  [/laguna[-_. ]?xs[-_. ]?2\.1/, "laguna-xs-2.1"],
  [/gpt-oss/, "gpt-oss"],
  // The catalog's helper model, which answers side requests (titles, page summaries).
  [/minicpm5/, "minicpm5"],
];

/**
 * The profile id for a model id such as "Qwen/Qwen3.8-27B", "qwen3.8:27b" or
 * "/models/Qwen3.8-27B-UD-Q4_K_M.gguf"; null (the default profile) for anything else. Only the
 * file name of a path counts, so a directory name cannot pick a profile.
 */
export function profileIdForModel(modelId: string): string | null {
  const name = (modelId.split("/").at(-1) ?? modelId).toLowerCase();
  for (const [pattern, id] of FAMILIES) {
    if (pattern.test(name) && hasModelProfile(id)) return id;
  }
  return null;
}
